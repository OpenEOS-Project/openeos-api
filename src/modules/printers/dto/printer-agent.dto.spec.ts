import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ReportDiscoveredPrintersDto } from './printer-agent.dto';

function report(details: Record<string, unknown>) {
  return plainToInstance(ReportDiscoveredPrintersDto, {
    full: true,
    printers: [
      {
        fingerprint: 'net:192.168.1.50',
        connectionType: 'network',
        displayName: 'EPSON TM-T88V',
        details,
        discoveredVia: 'portscan',
      },
    ],
  });
}

async function violations(dto: ReportDiscoveredPrintersDto) {
  const errors = await validate(dto, {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
  return JSON.stringify(errors);
}

describe('DiscoveredPrinterDetailsDto classification keys', () => {
  it('accepts escpos, kind and kindReason', async () => {
    const dto = report({
      ipAddress: '192.168.1.50',
      port: 9100,
      escpos: 'yes',
      kind: 'receipt',
      kindReason: 'antwortet auf ESC/POS-Modellabfrage',
    });
    expect(await violations(dto)).toBe('[]');
  });

  it('rejects values outside the enums', async () => {
    expect(await violations(report({ escpos: 'maybe' }))).toContain('escpos');
    expect(await violations(report({ kind: 'laser' }))).toContain('kind');
  });

  it('still rejects unknown detail keys', async () => {
    expect(await violations(report({ vendorGuess: 'Brother' }))).toContain(
      'vendorGuess',
    );
  });
});
