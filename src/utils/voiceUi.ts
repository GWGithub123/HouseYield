export const VOICE_ELEMENT_TYPES = [
  'button',
  'input',
  'link',
  'section',
  'card',
  'tab',
  'chart',
  'list',
  'unknown',
] as const;

export type VoiceElementType = typeof VOICE_ELEMENT_TYPES[number];

type VoiceUiAttrConfig = {
  id: string;
  label: string;
  type?: VoiceElementType;
  description?: string;
  pageSection?: string;
  keywords?: string[];
  interactive?: boolean;
};

export function isVoiceElementType(value: unknown): value is VoiceElementType {
  return typeof value === 'string' && VOICE_ELEMENT_TYPES.includes(value as VoiceElementType);
}

export function buildVoiceUiAttrs({
  id,
  label,
  type,
  description,
  pageSection,
  keywords,
  interactive,
}: VoiceUiAttrConfig): Record<string, string> {
  const attrs: Record<string, string> = {
    'data-voice-id': id,
    'data-voice-label': label,
  };

  if (type && type !== 'unknown') {
    attrs['data-voice-type'] = type;
  }

  if (description) {
    attrs['data-voice-description'] = description;
  }

  if (pageSection) {
    attrs['data-voice-section'] = pageSection;
  }

  if (keywords && keywords.length > 0) {
    attrs['data-voice-keywords'] = keywords.join('|');
  }

  if (typeof interactive === 'boolean') {
    attrs['data-voice-interactive'] = String(interactive);
  }

  return attrs;
}