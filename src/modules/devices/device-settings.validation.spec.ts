import { BadRequestException } from '@nestjs/common';
import type { DeviceSettings } from '../../database/entities/device.entity';
import {
  assertDeviceSettings,
  dropNullSettings,
} from './device-settings.validation';

describe('assertDeviceSettings', () => {
  it.each(['number', 'list', 'map'])('accepts tableSelectView %s', (view) => {
    expect(() =>
      assertDeviceSettings({ tableSelectView: view } as DeviceSettings),
    ).not.toThrow();
  });

  it('accepts missing settings, a missing value and null', () => {
    expect(() => assertDeviceSettings(undefined)).not.toThrow();
    expect(() => assertDeviceSettings({ serviceMode: 'table' })).not.toThrow();
    expect(() =>
      assertDeviceSettings({ tableSelectView: null } as never),
    ).not.toThrow();
  });

  it.each(['grid', '', 'Map', 1, true])(
    'rejects tableSelectView %p',
    (view) => {
      expect(() =>
        assertDeviceSettings({ tableSelectView: view } as never),
      ).toThrow(BadRequestException);
    },
  );
});

describe('dropNullSettings', () => {
  it('removes tableSelectView: null and keeps everything else', () => {
    expect(
      dropNullSettings({
        serviceMode: 'table',
        tableAreaId: 'a1',
        tableSelectView: null,
      } as never),
    ).toEqual({ serviceMode: 'table', tableAreaId: 'a1' });
  });
});

describe('refundPermission („Stornieren & Erstatten“)', () => {
  it.each([['allowed'], ['pin'], ['disabled'], [null], [undefined]])(
    'accepts %p',
    (value) => {
      expect(() =>
        assertDeviceSettings({ refundPermission: value } as never),
      ).not.toThrow();
    },
  );

  it.each([['yes'], [true], [1]])('rejects %p', (value) => {
    expect(() =>
      assertDeviceSettings({ refundPermission: value } as never),
    ).toThrow(BadRequestException);
  });

  it('null falls back to the default (allowed)', () => {
    expect(
      dropNullSettings({ refundPermission: null, soundEnabled: true } as never),
    ).toEqual({ soundEnabled: true });
  });
});
