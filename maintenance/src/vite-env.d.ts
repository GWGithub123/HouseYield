/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PRODUCT_MODE?: 'full' | 'maintenance';
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
