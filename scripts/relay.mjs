import process from 'node:process'

import { startRelayServer } from '../packages/relay/src/server.js'
import { createFastifyLoggerOptions } from '../packages/shared/src/dailyLogStream.js'

async function main() {
  await startRelayServer({
    logger: createFastifyLoggerOptions({ logName: 'relay' }),
  })
}

main().catch((error) => {
  console.error(`[promptx-relay] ${error.message || error}`)
  process.exitCode = 1
})
