function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function run(): Promise<void> {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        origin: 'http://localhost',
        pathname: '/',
        search: '',
      },
    },
  });

  try {
    const { encodeBase64 } = await import('../bridge/collab-client.js');
    const bytes = new Uint8Array(1024 * 1024);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 31 + 17) & 0xff;
    }

    const encoded = encodeBase64(bytes);
    const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
    assert(decoded.length === bytes.length, 'Expected large base64 update length to round-trip');
    for (let i = 0; i < bytes.length; i += 1) {
      if (decoded[i] !== bytes[i]) {
        throw new Error(`Expected byte ${i} to round-trip through browser base64 encoding`);
      }
    }
  } finally {
    if (windowDescriptor) {
      Object.defineProperty(globalThis, 'window', windowDescriptor);
    } else {
      delete (globalThis as { window?: unknown }).window;
    }
  }

  console.log('✓ collab client encodes large browser updates without spreading arguments');
}

run().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
