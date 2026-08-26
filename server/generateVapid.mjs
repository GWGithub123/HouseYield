import webPush from 'web-push'
import fs from 'fs'

const keys = webPush.generateVAPIDKeys()
const lines = []
lines.push(`VITE_VAPID_PUBLIC_KEY=${keys.publicKey}`)
lines.push(`VAPID_PUBLIC=${keys.publicKey}`)
lines.push(`VAPID_PRIVATE=${keys.privateKey}`)

fs.appendFileSync('.env.local', lines.join('\n') + '\n')
console.log('VAPID public and server-side private keys written to .env.local')