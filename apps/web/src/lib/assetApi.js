import { getApiBase, resolveRequestErrorMessage } from './request.js'

export async function uploadImage(file) {
  const body = new FormData()
  body.append('file', file)

  const response = await fetch(`${getApiBase()}/api/uploads`, {
    method: 'POST',
    body,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(resolveRequestErrorMessage(payload, 'errors.uploadFailed'))
  }

  return response.json()
}

export async function importPdf(file) {
  const body = new FormData()
  body.append('file', file)

  const response = await fetch(`${getApiBase()}/api/imports/pdf`, {
    method: 'POST',
    body,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(resolveRequestErrorMessage(payload, 'errors.pdfImportFailed'))
  }

  return response.json()
}
