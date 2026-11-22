// The picture inside a plugin's plug: a 5×4 field of cells drawn from the string that names
// the plugin's commit, mirrored left to right. Another commit is another picture.
export const PLUG_COLUMNS = 5;
export const PLUG_ROWS = 4;

export function plugPattern(seed: string): boolean[] {
  const half = 3; // columns 0-2 are drawn, 3 and 4 mirror 1 and 0
  const cells = new Array<number>(PLUG_ROWS * half).fill(0);
  let position = 0;
  for (const character of seed) {
    const code = character.charCodeAt(0);
    for (let bit = 0; bit < 4; bit++) {
      cells[position % cells.length] ^= ((code >> bit) ^ (code >> (bit + 4))) & 1;
      position++;
    }
  }
  // A field that came out nearly empty reads as a blank plug: turn it over.
  const lit = cells.reduce((sum, cell) => sum + cell, 0);
  const drawn = lit < 4 ? cells.map((cell) => 1 - cell) : cells;
  const field: boolean[] = [];
  for (let row = 0; row < PLUG_ROWS; row++)
    for (let column = 0; column < PLUG_COLUMNS; column++) {
      const source = column < half ? column : PLUG_COLUMNS - 1 - column;
      field.push(drawn[row * half + source] === 1);
    }
  return field;
}
