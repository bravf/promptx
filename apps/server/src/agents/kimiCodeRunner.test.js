import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isKimiInfoStderrLine,
} from './kimiCodeRunner.js'

test('isKimiInfoStderrLine treats resume hints as non-error metadata', () => {
  assert.equal(
    isKimiInfoStderrLine('To resume this session: kimi -r ffb2f903-1173-4f8a-a49a-c8b0deae3e2d'),
    true
  )
  assert.equal(
    isKimiInfoStderrLine('To resume this session: kimi --session ffb2f903-1173-4f8a-a49a-c8b0deae3e2d'),
    true
  )
})

test('isKimiInfoStderrLine keeps real stderr visible', () => {
  assert.equal(isKimiInfoStderrLine('Error: authentication failed'), false)
})
