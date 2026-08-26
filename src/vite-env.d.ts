/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_VAPID_PUBLIC_KEY: string;
  readonly VITE_PUSH_SERVER_URL?: string;
  readonly VITE_SHELLY_FIREBASE_WEBHOOK_URL?: string;
  readonly VITE_SHELLY_WEBHOOK_URL?: string;
  readonly VITE_SHELLY_SERVER_PUBLIC_URL?: string;
  readonly VITE_BACKEND_PUBLIC_URL?: string;
  readonly VITE_INTERNAL_STAFF_EMAILS?: string;
  readonly VITE_CUSTOMER_APP_URL?: string;
  readonly VITE_PRODUCT_MODE?: 'full' | 'maintenance';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
