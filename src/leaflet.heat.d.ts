// Type declarations for leaflet.heat
declare module 'leaflet.heat' {
  import * as L from 'leaflet';

  export default L;
  
  namespace L {
    function heatLayer(
      latlngs: Array<[number, number, number?]>,
      options?: HeatMapOptions
    ): HeatLayer;

    interface HeatMapOptions {
      minOpacity?: number;
      maxZoom?: number;
      max?: number;
      radius?: number;
      blur?: number;
      gradient?: { [key: number]: string };
    }

    interface HeatLayer extends L.Layer {
      setLatLngs(latlngs: Array<[number, number, number?]>): this;
      addLatLng(latlng: [number, number, number?]): this;
      setOptions(options: HeatMapOptions): this;
    }
  }
}
