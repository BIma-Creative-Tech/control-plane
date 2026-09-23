/**
 * Dipanggil sekali saat server Next start (docs file-conventions/instrumentation.md).
 * Validasi env → gagal cepat: Next 16.3.6 hanya me-log error dari register() dan tetap melayani
 * request (diuji), jadi proses dihentikan eksplisit agar Docker/compose melihat kegagalan.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getWebEnv } = await import("./env");
    try {
      getWebEnv();
    } catch (err) {
      console.error(err instanceof Error ? err.message : "Env tidak valid");
      process.exit(1);
    }
  }
}
