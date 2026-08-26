import { useState, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { getAssistantPageTitle } from '../utils/assistantPageCapabilities';
import { isVoiceElementType, type VoiceElementType } from '../utils/voiceUi';

export interface VisibleElement {
  voiceId: string;
  label: string;
  type: VoiceElementType;
  isInteractive: boolean;
  description?: string;
  section?: string;
  keywords?: string[];
  boundingRect?: { top: number; left: number; width: number; height: number };
}

export interface ScreenContext {
  currentPage: string;
  pageTitle: string;
  visibleElements: VisibleElement[];
  activeTab?: string;
  activeFilter?: string;
  selectedItems?: string[];
  scrollPosition: number;
  viewportHeight: number;
  timestamp: number;
}

const MAX_VISIBLE_ELEMENTS_FOR_PROMPT = 40;

function resolvePageTitle(pathname: string): string {
  if (pathname === '/') return 'Dashboard';
  return getAssistantPageTitle(pathname);
}

// Determine element type from tag and attributes
function getElementType(el: Element): VisibleElement['type'] {
  const tag = el.tagName.toLowerCase();
  const voiceId = el.getAttribute('data-voice-id') || '';
  const role = el.getAttribute('role');
  const explicitType = el.getAttribute('data-voice-type');

  if (isVoiceElementType(explicitType)) {
    return explicitType;
  }
  
  // Check for specific patterns in voiceId
  if (voiceId.includes('btn') || voiceId.includes('button')) return 'button';
  if (voiceId.includes('tab')) return 'tab';
  if (voiceId.includes('input') || voiceId.includes('search-box')) return 'input';
  if (voiceId.includes('card')) return 'card';
  if (voiceId.includes('chart') || voiceId.includes('graph')) return 'chart';
  if (voiceId.includes('list') || voiceId.includes('section')) return 'section';
  if (voiceId.includes('nav-')) return 'link';
  
  // Check tag type
  if (tag === 'button' || role === 'button') return 'button';
  if (tag === 'input' || tag === 'textarea') return 'input';
  if (tag === 'a') return 'link';
  if (tag === 'nav' || tag === 'section') return 'section';
  
  return 'unknown';
}

function getElementDescription(el: Element): string | undefined {
  const description = el.getAttribute('data-voice-description')
    || el.getAttribute('aria-description')
    || undefined;

  if (!description) return undefined;

  const normalized = description.trim().replace(/\s+/g, ' ');
  return normalized || undefined;
}

function getElementSection(el: Element): string | undefined {
  const section = el.getAttribute('data-voice-section') || undefined;

  if (!section) return undefined;

  const normalized = section.trim().replace(/\s+/g, ' ');
  return normalized || undefined;
}

function getElementKeywords(el: Element): string[] | undefined {
  const rawKeywords = el.getAttribute('data-voice-keywords');
  if (!rawKeywords) return undefined;

  const keywords = rawKeywords
    .split('|')
    .map((keyword) => keyword.trim())
    .filter(Boolean);

  return keywords.length > 0 ? keywords : undefined;
}

// Get human-readable label for an element
function getElementLabel(el: Element): string {
  // Priority 1: aria-label
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel;
  
  // Priority 2: title attribute
  const title = el.getAttribute('title');
  if (title) return title;
  
  // Priority 3: data-voice-label (custom attribute)
  const voiceLabel = el.getAttribute('data-voice-label');
  if (voiceLabel) return voiceLabel;
  
  // Priority 4: Text content (for buttons, links)
  const textContent = el.textContent?.trim();
  if (textContent && textContent.length < 100) {
    // Clean up the text
    return textContent.replace(/\s+/g, ' ').slice(0, 80);
  }
  
  // Priority 5: Derive from voice-id
  const voiceId = el.getAttribute('data-voice-id') || '';
  if (voiceId) {
    // Convert voice-id to readable label: "add-property-btn" -> "Add Property Button"
    return voiceId
      .replace(/-/g, ' ')
      .replace(/\b(btn|cta)\b/gi, 'button')
      .replace(/\bsection\b/gi, 'section')
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }
  
  return 'Unnamed Element';
}

// Check if element is interactive
function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  const role = el.getAttribute('role');
  const voiceId = el.getAttribute('data-voice-id') || '';
  const interactiveAttr = el.getAttribute('data-voice-interactive');

  if (interactiveAttr === 'true') return true;
  if (interactiveAttr === 'false') return false;
  
  // Interactive tags
  if (['button', 'a', 'input', 'select', 'textarea'].includes(tag)) return true;
  
  // Interactive roles
  if (['button', 'link', 'tab', 'checkbox', 'radio', 'switch', 'menuitem'].includes(role || '')) return true;
  
  // Interactive voice IDs
  if (voiceId.includes('btn') || voiceId.includes('button') || voiceId.includes('tab') || voiceId.includes('filter')) return true;
  
  // Has click handler (check for onclick or cursor pointer)
  const styles = window.getComputedStyle(el);
  if (styles.cursor === 'pointer') return true;
  
  return false;
}

// Check if element is visible in viewport
function isInViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const viewHeight = window.innerHeight || document.documentElement.clientHeight;
  const viewWidth = window.innerWidth || document.documentElement.clientWidth;
  
  // Element is at least partially visible
  return (
    rect.top < viewHeight &&
    rect.bottom > 0 &&
    rect.left < viewWidth &&
    rect.right > 0 &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function useScreenContext(): ScreenContext {
  const location = useLocation();
  const [context, setContext] = useState<ScreenContext>({
    currentPage: location.pathname,
    pageTitle: resolvePageTitle(location.pathname),
    visibleElements: [],
    scrollPosition: 0,
    viewportHeight: window.innerHeight,
    timestamp: Date.now(),
  });
  
  const updateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextSignatureRef = useRef('');
  
  // Scan the DOM for visible elements with data-voice-id
  const scanVisibleElements = useCallback(() => {
    const elements: VisibleElement[] = [];
    const voiceElements = document.querySelectorAll('[data-voice-id]');
    
    voiceElements.forEach(el => {
      if (!isInViewport(el)) return;
      
      const voiceId = el.getAttribute('data-voice-id')!;
      const rect = el.getBoundingClientRect();
      
      elements.push({
        voiceId,
        label: getElementLabel(el),
        type: getElementType(el),
        isInteractive: isInteractive(el),
        description: getElementDescription(el),
        section: getElementSection(el),
        keywords: getElementKeywords(el),
        boundingRect: {
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      });
    });
    
    // Sort by position (top to bottom, left to right)
    elements.sort((a, b) => {
      if (!a.boundingRect || !b.boundingRect) return 0;
      const topDiff = a.boundingRect.top - b.boundingRect.top;
      if (Math.abs(topDiff) > 50) return topDiff;
      return a.boundingRect.left - b.boundingRect.left;
    });
    
    return elements;
  }, []);
  
  // Detect active tabs and filters
  const detectActiveStates = useCallback(() => {
    let activeTab: string | undefined;
    let activeFilter: string | undefined;
    const selectedItems: string[] = [];
    
    // Find active tabs (look for aria-selected or active classes)
    document.querySelectorAll('[data-voice-id*="tab"]').forEach(el => {
      if (
        el.getAttribute('aria-selected') === 'true' ||
        el.classList.contains('active') ||
        el.classList.contains('bg-white') // Common active state
      ) {
        activeTab = el.getAttribute('data-voice-id') || undefined;
      }
    });
    
    // Find active filters
    document.querySelectorAll('[data-voice-id*="filter"]').forEach(el => {
      if (
        el.getAttribute('aria-pressed') === 'true' ||
        el.classList.contains('active') ||
        el.classList.contains('bg-white')
      ) {
        activeFilter = el.getAttribute('data-voice-id') || undefined;
      }
    });
    
    // Find selected items
    document.querySelectorAll('[data-voice-id][aria-selected="true"], [data-voice-id].selected').forEach(el => {
      const id = el.getAttribute('data-voice-id');
      if (id) selectedItems.push(id);
    });
    
    return { activeTab, activeFilter, selectedItems };
  }, []);
  
  // Update context with debouncing
  const updateContext = useCallback(() => {
    if (updateTimeoutRef.current) {
      clearTimeout(updateTimeoutRef.current);
    }
    
    updateTimeoutRef.current = setTimeout(() => {
      // Prefer React Router location; fall back to window only if needed.
      const currentPath = location.pathname || window.location.pathname;
      const visibleElements = scanVisibleElements();
      const { activeTab, activeFilter, selectedItems } = detectActiveStates();

      const nextContext: ScreenContext = {
        currentPage: currentPath,
        pageTitle: resolvePageTitle(currentPath),
        visibleElements,
        activeTab,
        activeFilter,
        selectedItems: selectedItems.length > 0 ? selectedItems : undefined,
        scrollPosition: window.scrollY,
        viewportHeight: window.innerHeight,
        timestamp: Date.now(),
      };
      const signature = JSON.stringify({
        ...nextContext,
        timestamp: undefined,
        scrollPosition: Math.round(nextContext.scrollPosition / 40) * 40,
        visibleElements: nextContext.visibleElements.map(({ boundingRect, ...element }) => ({
          ...element,
          boundingRect: boundingRect ? {
            ...boundingRect,
            top: Math.round(boundingRect.top / 20) * 20,
            left: Math.round(boundingRect.left / 20) * 20,
          } : undefined,
        })),
      });
      if (signature !== contextSignatureRef.current) {
        contextSignatureRef.current = signature;
        setContext(nextContext);
      }
    }, 250);
  }, [scanVisibleElements, detectActiveStates, location.pathname]);
  
  // Initial scan and set up observers
  useEffect(() => {
    // Initial scan - delay slightly to let page render
    const initialScan = setTimeout(() => {
      updateContext();
    }, 200);
    
    // Re-scan on scroll
    const handleScroll = () => updateContext();
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    // Re-scan on resize
    const handleResize = () => updateContext();
    window.addEventListener('resize', handleResize, { passive: true });
    
    // Observe application roots only — avoid full-document churn from overlays/toasts.
    const observer = new MutationObserver(() => updateContext());
    const roots = [
      document.getElementById('root'),
      document.querySelector('main'),
      document.querySelector('[data-app-root]'),
      document.querySelector('[data-voice-id="sidebar"]'),
    ].filter((node): node is Element => Boolean(node));
    const observeTargets = roots.length > 0 ? roots : [document.body];
    observeTargets.forEach((target) => {
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['aria-selected', 'aria-pressed', 'data-voice-id', 'hidden', 'class'],
      });
    });
    
    return () => {
      clearTimeout(initialScan);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
      if (updateTimeoutRef.current) {
        clearTimeout(updateTimeoutRef.current);
      }
    };
  }, [location.pathname, updateContext]);
  
  return context;
}

// Format context for AI prompt
export function formatScreenContextForAI(context: ScreenContext): string {
  const lines: string[] = [
    `Page: ${context.pageTitle} (${context.currentPage})`,
  ];

  if (context.activeTab) lines.push(`Active tab: ${context.activeTab}`);
  if (context.activeFilter) lines.push(`Active filter: ${context.activeFilter}`);

  const interactiveFirst = [...context.visibleElements].sort((a, b) => {
    if (a.isInteractive === b.isInteractive) return 0;
    return a.isInteractive ? -1 : 1;
  });
  const limited = interactiveFirst.slice(0, MAX_VISIBLE_ELEMENTS_FOR_PROMPT);

  if (limited.length > 0) {
    lines.push('Visible controls:');
    for (const el of limited) {
      const bits = [el.voiceId, el.label];
      if (el.section) bits.push(el.section);
      lines.push(`- ${bits.join(' · ')}`);
    }
    if (context.visibleElements.length > limited.length) {
      lines.push(`(+${context.visibleElements.length - limited.length} more off-prompt)`);
    }
  }

  return lines.join('\n');
}

export default useScreenContext;
