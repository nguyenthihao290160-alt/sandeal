import { cloudflareFetch } from '../src/lib/runtime/cloudflare/http';
import { cloudflareScheduled, cloudflareQueue } from '../src/lib/runtime/cloudflare/autopilot';
const worker = { fetch: cloudflareFetch, scheduled: cloudflareScheduled, queue: cloudflareQueue };
export default worker;
