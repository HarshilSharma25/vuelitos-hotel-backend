import https from 'node:https';
import tls from 'node:tls';

// BCV intermediate certificate bundle (or standard chain extension)
// BCV uses an intermediate CA not included in all default trust stores.
export const BCV_INTERMEDIATE_CERT = `-----BEGIN CERTIFICATE-----
MIIEkjCCA3qgAwIBAgIQCgFBQgAAAVOFc2oLheynCDANBgkqhkiG9w0BAQsFADA/
MSQwIgYDVQQKExtEaWdpQ2VydCwgSW5jLiAtIHd3dy5kaWdpY2VydC5jb20xFzAV
BgNVBAMTDkRpZ2lDZXJ0IEdsb2JhbCBDQTAeFw0xMzAzMDgxMjAwMDBaFw0yMzAz
MDgxMjAwMDBaMEcxCzAJBgNVBAYTAlVTMRUwEwYDVQQKEwxEaWdpQ2VydCBJbmMx
ITAfBgNVBAMTGERpZ2lDZXJ0IFNIQTIgU2VjdXJlIFNlcnZlcmlDQUExggEiMA0G
CSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCp/lH/mNfW4xT4J418Y9e0tXwA+QxZ
-----END CERTIFICATE-----`;

export interface BcvRateResult {
  usd: number;
  eur: number;
  valueDate: string; // YYYY-MM-DD
}

export function parseBcvHtml(html: string): BcvRateResult {
  let usd: number | null = null;
  let eur: number | null = null;
  let valueDate: string | null = null;

  // 1. Parse USD
  const dolarMatch =
    html.match(/id=["']dolar["'][\s\S]*?<strong>\s*([0-9.,]+)\s*<\/strong>/i) ||
    html.match(/USD[\s\S]*?<strong>\s*([0-9.,]+)\s*<\/strong>/i) ||
    html.match(/D[oó]lar[\s\S]*?([0-9]+[.,][0-9]+)/i);

  if (dolarMatch && dolarMatch[1]) {
    const cleanStr = dolarMatch[1].replace(/\./g, '').replace(',', '.');
    usd = parseFloat(cleanStr);
  }

  // 2. Parse EUR
  const euroMatch =
    html.match(/id=["']euro["'][\s\S]*?<strong>\s*([0-9.,]+)\s*<\/strong>/i) ||
    html.match(/EUR[\s\S]*?<strong>\s*([0-9.,]+)\s*<\/strong>/i) ||
    html.match(/Euro[\s\S]*?([0-9]+[.,][0-9]+)/i);

  if (euroMatch && euroMatch[1]) {
    const cleanStr = euroMatch[1].replace(/\./g, '').replace(',', '.');
    eur = parseFloat(cleanStr);
  }

  // 3. Parse Fecha Valor
  const dateMatch =
    html.match(/class=["'][^"']*date-display-single[^"']*["'][^>]*content=["']([0-9]{4}-[0-9]{2}-[0-9]{2})/i) ||
    html.match(/Fecha\s+Valor:[^<]*?([0-9]{4}-[0-9]{2}-[0-9]{2})/i) ||
    html.match(/Fecha\s+Valor:[^<]*?([0-9]{2})[/-]([0-9]{2})[/-]([0-9]{4})/i);

  if (dateMatch) {
    if (dateMatch[1] && dateMatch[1].includes('-') && dateMatch[1].length === 10) {
      valueDate = dateMatch[1];
    } else if (dateMatch[3]) {
      valueDate = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
    }
  }

  if (!usd || !eur || !valueDate) {
    throw new Error(
      `Failed to parse BCV values from HTML: usd=${usd}, eur=${eur}, valueDate=${valueDate}`
    );
  }

  return {
    usd: Number(usd.toFixed(4)),
    eur: Number(eur.toFixed(4)),
    valueDate,
  };
}

export async function fetchBcvRates(): Promise<BcvRateResult> {
  const url = 'https://www.bcv.org.ve/';

  // Custom agent with pinned intermediate cert + system roots
  const customAgent = new https.Agent({
    ca: [...tls.rootCertificates, BCV_INTERMEDIATE_CERT],
    rejectUnauthorized: true, // Keep TLS verification strictly ON
  });

  const responseText = await new Promise<string>((resolve, reject) => {
    const req = https.get(
      url,
      {
        agent: customAgent,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
        },
        timeout: 15000,
      },
      (res) => {
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          return reject(new Error(`BCV returned status code: ${res.statusCode}`));
        }
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => resolve(data));
      }
    );

    req.on('error', (err) => reject(err));
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('BCV request timed out'));
    });
  });

  return parseBcvHtml(responseText);
}
