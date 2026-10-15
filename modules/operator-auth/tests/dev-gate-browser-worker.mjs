// Real local identity and auth handlers on the browser runtime's HTTP listener.
import { withDevIdentity } from '../dev/index.mjs';
import { app, config } from './dev-worker.mjs';

export default withDevIdentity(app, { config });
