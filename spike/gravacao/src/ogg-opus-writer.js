// Escreve pacotes Opus crus (como o Discord entrega) num arquivo Ogg Opus (RFC 7845),
// sem recodificar e sem depender de ffmpeg. Um pacote por página Ogg: simples e válido.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc32Ogg(buf) {
  let crc = 0;
  for (const byte of buf) crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

/** Número de amostras (48 kHz) de um pacote Opus, lido do byte TOC (RFC 6716 §3.1). */
export function amostrasDoPacote(pacote) {
  if (pacote.length < 1) return 0;
  const toc = pacote[0];
  const config = toc >> 3;
  let duracaoFrame; // em amostras a 48 kHz
  if (config < 12) duracaoFrame = [480, 960, 1920, 2880][config & 3]; // SILK 10/20/40/60 ms
  else if (config < 16) duracaoFrame = [480, 960][config & 1]; // Hybrid 10/20 ms
  else duracaoFrame = [120, 240, 480, 960][config & 3]; // CELT 2.5/5/10/20 ms

  const c = toc & 3;
  let frames;
  if (c === 0) frames = 1;
  else if (c === 3) frames = pacote.length > 1 ? pacote[1] & 0x3f : 0;
  else frames = 2;
  return duracaoFrame * frames;
}

export class OggOpusWriter {
  #destino;
  #serial;
  #sequencia = 0;
  #granulo = 0n;
  #pendente = null; // segura um pacote para poder marcar o último com EOS
  #fechado = false;

  /**
   * @param {import('node:stream').Writable} destino
   * @param {{ canais?: number, preSkip?: number }} [opcoes]
   */
  constructor(destino, { canais = 2, preSkip = 0 } = {}) {
    this.#destino = destino;
    this.#serial = (Math.random() * 0xffffffff) >>> 0;
    this.pacotes = 0;

    const head = Buffer.alloc(19);
    head.write('OpusHead', 0, 'ascii');
    head.writeUInt8(1, 8); // versão
    head.writeUInt8(canais, 9);
    head.writeUInt16LE(preSkip, 10);
    head.writeUInt32LE(48000, 12); // taxa original (informativa)
    head.writeInt16LE(0, 16); // ganho
    head.writeUInt8(0, 18); // mapping family 0 (mono/estéreo)
    this.#escreverPagina(head, 0x02, 0n); // BOS

    const vendor = Buffer.from('botmrx-spike', 'utf8');
    const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
    tags.write('OpusTags', 0, 'ascii');
    tags.writeUInt32LE(vendor.length, 8);
    vendor.copy(tags, 12);
    tags.writeUInt32LE(0, 12 + vendor.length); // zero comentários
    this.#escreverPagina(tags, 0x00, 0n);
  }

  /** @param {Buffer} pacote pacote Opus */
  write(pacote) {
    if (this.#fechado) throw new Error('OggOpusWriter já foi fechado');
    if (this.#pendente) this.#escreverAudio(this.#pendente, false);
    this.#pendente = pacote;
  }

  /** Duração escrita até agora, em ms (sem contar o pacote pendente). */
  get duracaoMs() {
    return Number(this.#granulo) / 48;
  }

  /** Fecha o fluxo Ogg (marca EOS) e encerra o destino. */
  close() {
    if (this.#fechado) return Promise.resolve();
    this.#fechado = true;
    if (this.#pendente) {
      this.#escreverAudio(this.#pendente, true);
      this.#pendente = null;
    } else if (this.pacotes === 0) {
      // nenhum áudio: página vazia com EOS para o arquivo continuar válido
      this.#escreverPagina(Buffer.alloc(0), 0x04, 0n);
    }
    return new Promise((resolve, reject) => {
      this.#destino.once('error', reject);
      this.#destino.end(resolve);
    });
  }

  #escreverAudio(pacote, ultimo) {
    this.#granulo += BigInt(amostrasDoPacote(pacote));
    this.pacotes++;
    this.#escreverPagina(pacote, ultimo ? 0x04 : 0x00, this.#granulo);
  }

  #escreverPagina(dados, tipo, granulo) {
    // tabela de lacing: blocos de 255 + resto (um resto 0 indica fim exato do pacote)
    const lacing = [];
    let restante = dados.length;
    while (restante >= 255) {
      lacing.push(255);
      restante -= 255;
    }
    lacing.push(restante);
    if (lacing.length > 255) throw new Error(`Pacote grande demais para uma página Ogg: ${dados.length} bytes`);

    const cabecalho = Buffer.alloc(27 + lacing.length);
    cabecalho.write('OggS', 0, 'ascii');
    cabecalho.writeUInt8(0, 4); // versão
    cabecalho.writeUInt8(tipo, 5);
    cabecalho.writeBigUInt64LE(granulo, 6);
    cabecalho.writeUInt32LE(this.#serial, 14);
    cabecalho.writeUInt32LE(this.#sequencia++, 18);
    cabecalho.writeUInt32LE(0, 22); // CRC, preenchido abaixo
    cabecalho.writeUInt8(lacing.length, 26);
    Buffer.from(lacing).copy(cabecalho, 27);

    const pagina = Buffer.concat([cabecalho, dados]);
    pagina.writeUInt32LE(crc32Ogg(pagina), 22);
    this.#destino.write(pagina);
  }
}
