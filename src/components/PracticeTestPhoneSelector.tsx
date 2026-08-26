import { useEffect, useState } from 'react';
import {
  DEFAULT_PRACTICE_TEST_PHONE_OPTIONS,
  formatPracticePhoneLabel,
  getStoredPracticeTestPhone,
  setStoredPracticeTestPhone,
  type PracticeTestPhoneOption,
} from '../utils/practiceTestPhone';
import { getDevApiBaseUrl } from '../utils/devApiBase';

interface PracticeTestPhoneSelectorProps {
  className?: string;
  compact?: boolean;
  onChange?: (phone: string) => void;
}

export default function PracticeTestPhoneSelector({
  className = '',
  compact = false,
  onChange,
}: PracticeTestPhoneSelectorProps) {
  const [selectedPhone, setSelectedPhone] = useState(getStoredPracticeTestPhone);
  const [options, setOptions] = useState<PracticeTestPhoneOption[]>(DEFAULT_PRACTICE_TEST_PHONE_OPTIONS);

  useEffect(() => {
    const stored = getStoredPracticeTestPhone();
    setSelectedPhone(stored);
    onChange?.(stored);

    const baseUrl = getDevApiBaseUrl();
    fetch(`${baseUrl}/api/maintenance/practice-settings?practiceTestPhone=${encodeURIComponent(stored)}`)
      .then((response) => response.json())
      .then((data) => {
        if (data.ok && Array.isArray(data.options) && data.options.length > 0) {
          setOptions(data.options);
        }
        if (data.ok && data.selectedPhone) {
          const nextPhone = setStoredPracticeTestPhone(data.selectedPhone);
          setSelectedPhone(nextPhone);
          onChange?.(nextPhone);
        }
      })
      .catch(() => {
        // Keep local defaults when backend is unavailable.
      });
  }, [onChange]);

  const handleChange = (phone: string) => {
    const nextPhone = setStoredPracticeTestPhone(phone);
    setSelectedPhone(nextPhone);
    onChange?.(nextPhone);
  };

  return (
    <div className={`rounded-lg border border-purple-100 bg-purple-50/70 ${compact ? 'p-2' : 'p-3'} ${className}`}>
      <div className={`${compact ? 'text-[11px]' : 'text-xs'} font-medium text-purple-800`}>
        Practice SMS approval target
      </div>
      <div className={`${compact ? 'text-[10px] mt-1' : 'text-[11px] mt-1'} text-purple-700`}>
        Practice texts and booking calls go to (202) 642-0437 while practice mode is on.
      </div>
      <div className={`${compact ? 'text-[10px] mt-1.5' : 'text-[11px] mt-2'} text-purple-600`}>
        Target: {formatPracticePhoneLabel(selectedPhone)}
      </div>
    </div>
  );
}
