import { SetMetadata } from '@nestjs/common';
import { DeviceCapabilityName } from '../constants/device-capabilities';

export const DEVICE_CAPABILITY_KEY = 'deviceCapability';

/**
 * Welche Faehigkeit ein Geraete-Endpunkt verlangt (siehe
 * device-capabilities.ts). An der Methode oder am ganzen Controller;
 * die Methode gewinnt.
 */
export const DeviceCapability = (capability: DeviceCapabilityName) =>
  SetMetadata(DEVICE_CAPABILITY_KEY, capability);
