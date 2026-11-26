/**
 * GB18030 text support.
 *
 * Node has a GB18030 decoder through ICU but no encoder. This module keeps a
 * compact encoding table derived from that same decoder: every four-byte
 * pointer that decodes to exactly one code point is grouped into a linear run
 * (start pointer, start code point, end pointer). The two-byte table is built
 * lazily from the decoder as well, so decoding and encoding always agree.
 */

let twoByteTable: Map<number, readonly [number, number]> | null = null;

const GB18030_FOUR_BYTE_RANGES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 0x80, 35],
  [36, 0xA5, 37],
  [38, 0xA9, 44],
  [45, 0xB2, 49],
  [50, 0xB8, 80],
  [81, 0xD8, 88],
  [89, 0xE2, 94],
  [95, 0xEB, 95],
  [96, 0xEE, 99],
  [100, 0xF4, 102],
  [103, 0xF8, 103],
  [104, 0xFB, 104],
  [105, 0xFD, 108],
  [109, 0x102, 125],
  [126, 0x114, 132],
  [133, 0x11C, 147],
  [148, 0x12C, 171],
  [172, 0x145, 174],
  [175, 0x149, 178],
  [179, 0x14E, 207],
  [208, 0x16C, 305],
  [306, 0x1CF, 306],
  [307, 0x1D1, 307],
  [308, 0x1D3, 308],
  [309, 0x1D5, 309],
  [310, 0x1D7, 310],
  [311, 0x1D9, 311],
  [312, 0x1DB, 312],
  [313, 0x1DD, 340],
  [341, 0x1FA, 427],
  [428, 0x252, 442],
  [443, 0x262, 543],
  [544, 0x2C8, 544],
  [545, 0x2CC, 557],
  [558, 0x2DA, 740],
  [741, 0x3A2, 741],
  [742, 0x3AA, 748],
  [749, 0x3C2, 749],
  [750, 0x3CA, 804],
  [805, 0x402, 818],
  [819, 0x450, 819],
  [820, 0x452, 7456],
  [7457, 0xE7C7, 7457],
  [7458, 0x1E40, 7921],
  [7922, 0x2011, 7923],
  [7924, 0x2017, 7924],
  [7925, 0x201A, 7926],
  [7927, 0x201E, 7933],
  [7934, 0x2027, 7942],
  [7943, 0x2031, 7943],
  [7944, 0x2034, 7944],
  [7945, 0x2036, 7949],
  [7950, 0x203C, 8061],
  [8062, 0x20AD, 8147],
  [8148, 0x2104, 8148],
  [8149, 0x2106, 8151],
  [8152, 0x210A, 8163],
  [8164, 0x2117, 8173],
  [8174, 0x2122, 8235],
  [8236, 0x216C, 8239],
  [8240, 0x217A, 8261],
  [8262, 0x2194, 8263],
  [8264, 0x219A, 8373],
  [8374, 0x2209, 8379],
  [8380, 0x2210, 8380],
  [8381, 0x2212, 8383],
  [8384, 0x2216, 8387],
  [8388, 0x221B, 8389],
  [8390, 0x2221, 8391],
  [8392, 0x2224, 8392],
  [8393, 0x2226, 8393],
  [8394, 0x222C, 8395],
  [8396, 0x222F, 8400],
  [8401, 0x2238, 8405],
  [8406, 0x223E, 8415],
  [8416, 0x2249, 8418],
  [8419, 0x224D, 8423],
  [8424, 0x2253, 8436],
  [8437, 0x2262, 8438],
  [8439, 0x2268, 8444],
  [8445, 0x2270, 8481],
  [8482, 0x2296, 8484],
  [8485, 0x229A, 8495],
  [8496, 0x22A6, 8520],
  [8521, 0x22C0, 8602],
  [8603, 0x2313, 8935],
  [8936, 0x246A, 8945],
  [8946, 0x249C, 9045],
  [9046, 0x254C, 9049],
  [9050, 0x2574, 9062],
  [9063, 0x2590, 9065],
  [9066, 0x2596, 9075],
  [9076, 0x25A2, 9091],
  [9092, 0x25B4, 9099],
  [9100, 0x25BE, 9107],
  [9108, 0x25C8, 9110],
  [9111, 0x25CC, 9112],
  [9113, 0x25D0, 9130],
  [9131, 0x25E6, 9161],
  [9162, 0x2607, 9163],
  [9164, 0x260A, 9217],
  [9218, 0x2641, 9218],
  [9219, 0x2643, 11328],
  [11329, 0x2E82, 11330],
  [11331, 0x2E85, 11333],
  [11334, 0x2E89, 11335],
  [11336, 0x2E8D, 11345],
  [11346, 0x2E98, 11360],
  [11361, 0x2EA8, 11362],
  [11363, 0x2EAB, 11365],
  [11366, 0x2EAF, 11369],
  [11370, 0x2EB4, 11371],
  [11372, 0x2EB8, 11374],
  [11375, 0x2EBC, 11388],
  [11389, 0x2ECB, 11681],
  [11682, 0x2FFC, 11685],
  [11686, 0x3004, 11686],
  [11687, 0x3018, 11691],
  [11692, 0x301F, 11693],
  [11694, 0x302A, 11713],
  [11714, 0x303F, 11715],
  [11716, 0x3094, 11722],
  [11723, 0x309F, 11724],
  [11725, 0x30F7, 11729],
  [11730, 0x30FF, 11735],
  [11736, 0x312A, 11981],
  [11982, 0x322A, 11988],
  [11989, 0x3232, 12101],
  [12102, 0x32A4, 12335],
  [12336, 0x3390, 12347],
  [12348, 0x339F, 12349],
  [12350, 0x33A2, 12383],
  [12384, 0x33C5, 12392],
  [12393, 0x33CF, 12394],
  [12395, 0x33D3, 12396],
  [12397, 0x33D6, 12509],
  [12510, 0x3448, 12552],
  [12553, 0x3474, 12850],
  [12851, 0x359F, 12961],
  [12962, 0x360F, 12972],
  [12973, 0x361B, 13737],
  [13738, 0x3919, 13822],
  [13823, 0x396F, 13918],
  [13919, 0x39D1, 13932],
  [13933, 0x39E0, 14079],
  [14080, 0x3A74, 14297],
  [14298, 0x3B4F, 14584],
  [14585, 0x3C6F, 14697],
  [14698, 0x3CE1, 15582],
  [15583, 0x4057, 15846],
  [15847, 0x4160, 16317],
  [16318, 0x4338, 16433],
  [16434, 0x43AD, 16437],
  [16438, 0x43B2, 16480],
  [16481, 0x43DE, 16728],
  [16729, 0x44D7, 17101],
  [17102, 0x464D, 17121],
  [17122, 0x4662, 17314],
  [17315, 0x4724, 17319],
  [17320, 0x472A, 17401],
  [17402, 0x477D, 17417],
  [17418, 0x478E, 17858],
  [17859, 0x4948, 17908],
  [17909, 0x497B, 17910],
  [17911, 0x497E, 17914],
  [17915, 0x4984, 17915],
  [17916, 0x4987, 17935],
  [17936, 0x499C, 17938],
  [17939, 0x49A0, 17960],
  [17961, 0x49B8, 18663],
  [18664, 0x4C78, 18702],
  [18703, 0x4CA4, 18813],
  [18814, 0x4D1A, 18961],
  [18962, 0x4DAF, 19042],
  [19043, 0x9FA6, 33468],
  [33469, 0xE76C, 33469],
  [33470, 0xE7C8, 33470],
  [33471, 0xE7E7, 33483],
  [33484, 0xE815, 33484],
  [33485, 0xE819, 33489],
  [33490, 0xE81F, 33496],
  [33497, 0xE827, 33500],
  [33501, 0xE82D, 33504],
  [33505, 0xE833, 33512],
  [33513, 0xE83C, 33519],
  [33520, 0xE844, 33535],
  [33536, 0xE856, 33549],
  [33550, 0xE865, 37844],
  [37845, 0xF92D, 37920],
  [37921, 0xF97A, 37947],
  [37948, 0xF996, 38028],
  [38029, 0xF9E8, 38037],
  [38038, 0xF9F2, 38063],
  [38064, 0xFA10, 38064],
  [38065, 0xFA12, 38065],
  [38066, 0xFA15, 38068],
  [38069, 0xFA19, 38074],
  [38075, 0xFA22, 38075],
  [38076, 0xFA25, 38077],
  [38078, 0xFA2A, 39107],
  [39108, 0xFE32, 39108],
  [39109, 0xFE45, 39112],
  [39113, 0xFE53, 39113],
  [39114, 0xFE58, 39114],
  [39115, 0xFE67, 39115],
  [39116, 0xFE6C, 39264],
  [39265, 0xFF5F, 39393],
  [39394, 0xFFE6, 39419],
  [189000, 0x10000, 1237575],
];;

function fourByteBytes(pointer: number): [number, number, number, number] {
  const fourth = pointer % 10;
  const third = Math.floor(pointer / 10) % 126;
  const second = Math.floor(pointer / 1260) % 10;
  const first = Math.floor(pointer / 12600);
  return [0x81 + first, 0x30 + second, 0x81 + third, 0x30 + fourth];
}

function buildTwoByteTable(): Map<number, readonly [number, number]> {
  const table = new Map<number, readonly [number, number]>();
  const decoder = new TextDecoder('gb18030', { fatal: true });
  for (let first = 0x81; first <= 0xfe; first += 1) {
    for (let second = 0x40; second <= 0xfe; second += 1) {
      if (second === 0x7f) continue;
      let decoded: string;
      try {
        decoded = decoder.decode(new Uint8Array([first, second]));
      } catch {
        continue;
      }
      if (decoded.length !== 1) continue;
      const codePoint = decoded.codePointAt(0);
      if (codePoint === undefined || table.has(codePoint)) continue;
      table.set(codePoint, [first, second] as const);
    }
  }
  return table;
}

export function decodeGb18030(bytes: Uint8Array): string {
  const decoder = new TextDecoder('gb18030', { fatal: true });
  // Streaming mode withholds an incomplete trailing sequence instead of
  // failing the whole read. The withheld bytes belong to the next read.
  return decoder.decode(bytes, { stream: true });
}

/**
 * Encodes text as GB18030. Throws a RangeError naming the first code point
 * that the decoder's mapping cannot represent, so callers can refuse a lossy
 * write instead of substituting characters.
 */
export function encodeGb18030(value: string): Uint8Array {
  if (twoByteTable === null) twoByteTable = buildTwoByteTable();
  const table = twoByteTable;
  const parts: number[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint < 0x80) {
      parts.push(codePoint);
      continue;
    }
    const pair = table.get(codePoint);
    if (pair) {
      parts.push(pair[0], pair[1]);
      continue;
    }
    const range = findRange(codePoint);
    if (!range) {
      throw new RangeError(
        `GB18030 ???????? U+${codePoint
          .toString(16)
          .toUpperCase()
          .padStart(4, '0')}`,
      );
    }
    const pointer = range[0] + (codePoint - range[1]);
    parts.push(...fourByteBytes(pointer));
  }
  return Uint8Array.from(parts);
}

function findRange(
  codePoint: number,
): readonly [number, number, number] | null {
  let low = 0;
  let high = GB18030_FOUR_BYTE_RANGES.length - 1;
  let index = -1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (GB18030_FOUR_BYTE_RANGES[middle][1] <= codePoint) {
      index = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (index < 0) return null;
  const range = GB18030_FOUR_BYTE_RANGES[index];
  const endCodePoint = range[1] + (range[2] - range[0]);
  if (codePoint > endCodePoint) return null;
  return range;
}
