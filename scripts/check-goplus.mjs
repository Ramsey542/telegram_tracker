import 'dotenv/config';
import { GoPlusClient } from '../dist/providers/goplus.js';
import { HttpClient, safeError } from '../dist/infra/http.js';

try {
  const goplusAppKey = process.env.GOPLUS_APP_KEY?.trim() ?? '';
  const goplusAppSecret = process.env.GOPLUS_APP_SECRET?.trim() ?? '';
  if (!goplusAppKey || !goplusAppSecret)
    throw new Error('Set GOPLUS_APP_KEY and GOPLUS_APP_SECRET in .env');
  const client = new GoPlusClient(
    { goplusAppKey, goplusAppSecret, goplusToken: '' },
    new HttpClient(15_000),
  );
  const report = await client.security('0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73');
  console.info(
    JSON.stringify({
      event: 'goplus.credentials_verified',
      authentication: 'app_key_and_secret',
      chainId: 4663,
      securityResponseReceived: true,
      returnedFields: Object.keys(report),
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({ event: 'goplus.credentials_check_failed', message: safeError(error) }),
  );
  process.exitCode = 1;
}
