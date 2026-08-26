export interface GoogleMapsHeatmapPoint {
  location: any;
  weight?: number;
}

export interface GoogleMapsHeatmapOptions {
  data: GoogleMapsHeatmapPoint[];
  map?: any;
  radius?: number;
  opacity?: number;
  maxIntensity?: number;
  dissipating?: boolean;
  gradient?: string[];
}

export interface GoogleMapsHeatmapLayerLike {
  setMap(map: any | null): void;
  setOptions(options: Partial<GoogleMapsHeatmapOptions>): void;
}

type Rgba = [number, number, number, number];

const DEFAULT_GRADIENT = [
  'rgba(0, 0, 0, 0)',
  'rgba(0, 255, 0, 0.45)',
  'rgba(255, 255, 0, 0.65)',
  'rgba(255, 128, 0, 0.8)',
  'rgba(255, 0, 0, 0.9)',
];

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function parseCssColor(value: string): Rgba {
  const rgbaMatch = value.match(/rgba?\(([^)]+)\)/i);
  if (rgbaMatch) {
    const parts = rgbaMatch[1].split(',').map((part) => part.trim());
    return [
      clamp(Number(parts[0]), 0, 255),
      clamp(Number(parts[1]), 0, 255),
      clamp(Number(parts[2]), 0, 255),
      parts[3] === undefined ? 1 : clamp(Number(parts[3])),
    ];
  }

  const hex = value.replace('#', '').trim();
  if (hex.length === 3 || hex.length === 6) {
    const normalized = hex.length === 3
      ? hex.split('').map((part) => part + part).join('')
      : hex;
    return [
      parseInt(normalized.slice(0, 2), 16),
      parseInt(normalized.slice(2, 4), 16),
      parseInt(normalized.slice(4, 6), 16),
      1,
    ];
  }

  return [255, 0, 0, 0.8];
}

function getGradientColor(intensity: number, gradient: string[]): Rgba {
  const colors = (gradient.length ? gradient : DEFAULT_GRADIENT).map(parseCssColor);
  if (colors.length === 1) return colors[0];

  const scaled = clamp(intensity) * (colors.length - 1);
  const leftIndex = Math.floor(scaled);
  const rightIndex = Math.min(colors.length - 1, leftIndex + 1);
  const localT = scaled - leftIndex;
  const left = colors[leftIndex];
  const right = colors[rightIndex];

  return [
    Math.round(left[0] + (right[0] - left[0]) * localT),
    Math.round(left[1] + (right[1] - left[1]) * localT),
    Math.round(left[2] + (right[2] - left[2]) * localT),
    left[3] + (right[3] - left[3]) * localT,
  ];
}

function getLatLng(location: any): { lat: number; lng: number } | null {
  if (!location) return null;

  const lat = typeof location.lat === 'function' ? location.lat() : location.lat;
  const lng = typeof location.lng === 'function' ? location.lng() : location.lng;
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);

  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  return { lat: parsedLat, lng: parsedLng };
}

export function createGoogleMapsHeatmapLayer(options: GoogleMapsHeatmapOptions): GoogleMapsHeatmapLayerLike {
  const google = (window as any).google;
  if (!google?.maps?.OverlayView) {
    throw new Error('Google Maps OverlayView is not available');
  }

  class CanvasGoogleMapsHeatmapLayer extends google.maps.OverlayView implements GoogleMapsHeatmapLayerLike {
    private canvas: HTMLCanvasElement | null = null;
    private currentOptions: GoogleMapsHeatmapOptions;

    constructor(initialOptions: GoogleMapsHeatmapOptions) {
      super();
      this.currentOptions = { radius: 30, opacity: 0.65, maxIntensity: 1, dissipating: true, ...initialOptions };
      if (initialOptions.map) {
        this.setMap(initialOptions.map);
      }
    }

    onAdd() {
      this.canvas = document.createElement('canvas');
      this.canvas.style.position = 'absolute';
      this.canvas.style.pointerEvents = 'none';
      this.canvas.style.zIndex = '1';
      this.getPanes()?.overlayLayer.appendChild(this.canvas);
    }

    draw() {
      if (!this.canvas) return;

      const map = this.getMap?.();
      const projection = this.getProjection?.();
      const bounds = map?.getBounds?.();
      if (!projection || !bounds) return;

      const northEast = bounds.getNorthEast();
      const southWest = bounds.getSouthWest();
      const topLeft = projection.fromLatLngToDivPixel(new google.maps.LatLng(northEast.lat(), southWest.lng()));
      const bottomRight = projection.fromLatLngToDivPixel(new google.maps.LatLng(southWest.lat(), northEast.lng()));
      if (!topLeft || !bottomRight) return;

      const width = Math.max(1, Math.ceil(bottomRight.x - topLeft.x));
      const height = Math.max(1, Math.ceil(bottomRight.y - topLeft.y));
      if (width > 6000 || height > 6000) return;

      this.canvas.style.left = `${topLeft.x}px`;
      this.canvas.style.top = `${topLeft.y}px`;
      this.canvas.style.width = `${width}px`;
      this.canvas.style.height = `${height}px`;
      this.canvas.width = width;
      this.canvas.height = height;

      const alphaContext = this.canvas.getContext('2d');
      if (!alphaContext) return;

      alphaContext.clearRect(0, 0, width, height);
      alphaContext.globalCompositeOperation = 'lighter';

      const radius = Math.max(1, Number(this.currentOptions.radius || 30));
      const opacity = clamp(Number(this.currentOptions.opacity ?? 0.65));
      const maxIntensity = Math.max(0.0001, Number(this.currentOptions.maxIntensity || 1));
      const dissipating = this.currentOptions.dissipating !== false;

      for (const point of this.currentOptions.data || []) {
        const latLng = getLatLng(point.location);
        if (!latLng) continue;

        const pixel = projection.fromLatLngToDivPixel(new google.maps.LatLng(latLng.lat, latLng.lng));
        if (!pixel) continue;

        const x = pixel.x - topLeft.x;
        const y = pixel.y - topLeft.y;
        if (x < -radius || x > width + radius || y < -radius || y > height + radius) continue;

        const intensity = clamp(Number(point.weight ?? 1) / maxIntensity);
        if (intensity <= 0) continue;

        if (dissipating) {
          const radialGradient = alphaContext.createRadialGradient(x, y, 0, x, y, radius);
          radialGradient.addColorStop(0, `rgba(255, 255, 255, ${intensity})`);
          radialGradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
          alphaContext.fillStyle = radialGradient;
        } else {
          alphaContext.fillStyle = `rgba(255, 255, 255, ${intensity})`;
        }

        alphaContext.beginPath();
        alphaContext.arc(x, y, radius, 0, Math.PI * 2);
        alphaContext.fill();
      }

      alphaContext.globalCompositeOperation = 'source-over';
      const imageData = alphaContext.getImageData(0, 0, width, height);
      const pixels = imageData.data;
      const gradient = this.currentOptions.gradient || DEFAULT_GRADIENT;

      for (let index = 0; index < pixels.length; index += 4) {
        const intensity = pixels[index] / 255;
        if (intensity <= 0) {
          pixels[index + 3] = 0;
          continue;
        }

        const [red, green, blue, alpha] = getGradientColor(intensity, gradient);
        pixels[index] = red;
        pixels[index + 1] = green;
        pixels[index + 2] = blue;
        pixels[index + 3] = Math.round(clamp(alpha * opacity) * 255);
      }

      alphaContext.putImageData(imageData, 0, 0);
    }

    onRemove() {
      if (this.canvas?.parentNode) {
        this.canvas.parentNode.removeChild(this.canvas);
      }
      this.canvas = null;
    }

    setOptions(nextOptions: Partial<GoogleMapsHeatmapOptions>) {
      this.currentOptions = { ...this.currentOptions, ...nextOptions };
      this.draw();
    }
  }

  return new CanvasGoogleMapsHeatmapLayer(options);
}