import { useCallback, useEffect, useState } from 'react';
import { buildOwnerFinanceUrl } from '../services/ownerFinanceApi';

type TenantCorrespondenceMessage = {
  id?: string;
  tenantId?: string;
  tenantEmail?: string;
  tenantName?: string;
  subject?: string;
  message?: string;
  body?: string;
  content?: string;
  createdAt?: string;
};

function normalizeSummary(summary: unknown): string[] {
  if (!Array.isArray(summary)) {
    return [];
  }

  return summary
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

export function useTenantCorrespondenceSummary({
  ownerId,
  propertyId,
  enabled = true,
}: {
  ownerId: string | null | undefined;
  propertyId: string | null | undefined;
  enabled?: boolean;
}) {
  const [summary, setSummary] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!enabled || !ownerId || !propertyId) {
      setSummary([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const ownerMessagesResponse = await fetch(
        buildOwnerFinanceUrl(
          `/api/owner/messages?ownerId=${encodeURIComponent(ownerId)}&propertyId=${encodeURIComponent(propertyId)}`,
        ),
      );
      const ownerMessagesPayload = await ownerMessagesResponse.json().catch(() => ({}));

      if (!ownerMessagesResponse.ok || ownerMessagesPayload?.ok === false) {
        throw new Error(ownerMessagesPayload?.error || `Failed to load tenant messages (${ownerMessagesResponse.status})`);
      }

      const messages = Array.isArray(ownerMessagesPayload?.messages)
        ? ownerMessagesPayload.messages as TenantCorrespondenceMessage[]
        : [];

      if (messages.length === 0) {
        setSummary([]);
        return;
      }

      const summaryResponse = await fetch(buildOwnerFinanceUrl('/api/tenant-summary'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages }),
      });
      const summaryPayload = await summaryResponse.json().catch(() => ({}));

      if (!summaryResponse.ok || summaryPayload?.ok === false) {
        throw new Error(summaryPayload?.error || `Failed to generate tenant summary (${summaryResponse.status})`);
      }

      setSummary(normalizeSummary(summaryPayload?.summary));
    } catch (error) {
      setSummary([`Error: ${error instanceof Error ? error.message : 'Unable to generate summary'}`]);
    } finally {
      setLoading(false);
    }
  }, [enabled, ownerId, propertyId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return {
    summary,
    loading,
    refresh,
  };
}