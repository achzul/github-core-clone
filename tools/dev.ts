// A local development launcher (not part of the graded surface): serves the forge
// directly on a fixed port without the make.fun env lifecycle, for curl and
// git-CLI end-to-end tests.
//
//   MAKEFUN_SHOP_TOKEN=dev-token DEV_PORT=4173 node --experimental-strip-types tools/dev.ts
//
// Then, for example:
//   git clone http://127.0.0.1:4173/adaiversen/<repo>.git
// (git will not send the bearer token by itself; pass it with
//  -c http.extraHeader="Authorization: Bearer dev-token".)

import { createApp } from '../app.ts';

const port = Number(process.env.DEV_PORT ?? '4173');
const server = createApp();
server.listen(port, () => {
  process.stdout.write(`[dev] forge listening on http://127.0.0.1:${port}\n`);
});
