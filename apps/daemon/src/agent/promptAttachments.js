import fs from 'node:fs/promises'

export function filePromptText(block) {
  return [
    `Uploaded file: ${block.name}`,
    `Path: ${block.absolutePath}`,
    `MIME: ${block.mimeType}`,
    `Size: ${block.size} bytes`,
  ].join('\n')
}

export async function imageBase64(block) {
  return (await fs.readFile(block.absolutePath)).toString('base64')
}
