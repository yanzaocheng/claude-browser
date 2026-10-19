import { test } from 'node:test';
import assert from 'node:assert/strict';
import { speechVoices, screenArea, resolveRuntime, normalizeFingerprint } from '../src/fingerprint.js';

test('Windows voices follow the display language, falling back to the base language then en-US', () => {
  assert.deepEqual(
    speechVoices('windows', 'ja-JP').list.map((v) => v.name),
    ['Microsoft Ayumi - Japanese (Japan)', 'Microsoft Haruka - Japanese (Japan)', 'Microsoft Ichiro - Japanese (Japan)'],
  );
  assert.equal(speechVoices('windows', 'de-LU').list[0].lang, 'de-DE');
  assert.equal(speechVoices('windows', 'xx-YY').list[0].name, 'Microsoft David - English (United States)');
  assert.equal(speechVoices('windows', 'zh-CN').defaultIndex, 0);
});

test('macOS has its fixed voice set with a language-dependent default; Linux has none', () => {
  const ja = speechVoices('macos', 'ja-JP');
  assert.equal(ja.list[ja.defaultIndex].name, 'Kyoko');
  const us = speechVoices('macos', 'en-US');
  assert.equal(us.list[us.defaultIndex].name, 'Samantha');
  assert.equal(us.list.length, ja.list.length);
  assert.deepEqual(speechVoices('linux', 'en-US').list, []);
});

test('screen work area leaves room for the taskbar / menu bar', () => {
  assert.equal(screenArea('windows', 1920, 1080, '15.0.0').availHeight, 1032); // Windows 11
  assert.equal(screenArea('windows', 1920, 1080, '10.0.0').availHeight, 1040); // Windows 10
  assert.deepEqual(screenArea('macos', 1440, 900, '14.6.1'), { width: 1440, height: 900, availWidth: 1440, availHeight: 875, availLeft: 0, availTop: 25 });
});

test('runtime config: voices follow the IP language, can be turned off; color gamut follows the OS', () => {
  const browser = { kind: 'chrome', major: 155 };
  const fp = normalizeFingerprint({ os: 'windows', language: { mode: 'ip' }, screen: { mode: 'custom', width: 1536, height: 864 }, platformVersion: '15.0.0' });
  const rt = resolveRuntime(fp, { countryCode: 'FR', timezone: 'Europe/Paris' }, browser);
  assert.equal(rt.spoof.voices.list[0].lang, 'fr-FR');
  assert.equal(rt.colorGamut, 'srgb');
  assert.equal(rt.spoof.screen.availHeight, 864 - 48);
  assert.equal(resolveRuntime({ ...fp, voices: 'real' }, null, browser).spoof.voices, null);
  assert.equal(resolveRuntime({ ...fp, os: 'macos' }, null, browser).colorGamut, 'p3');
});
