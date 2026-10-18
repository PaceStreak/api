/**
 * Types for the workerd-only WebCrypto extension that src/lib/crypto/consttime.ts uses, so Node scripts can import
 * src/lib/crypto/pbkdf2.ts. Scripts only hash (scripts/admin.ts); nothing run under Node calls this method.
 */
export {};

declare module "crypto" {
  namespace webcrypto {
    interface SubtleCrypto {
      timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
    }
  }
}
