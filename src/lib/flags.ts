// ISO-код страны гонки по названию Гран-при (для SVG-флага). Без картинок из сети.
// Ключ — фрагмент названия из Jolpica (англ.), значение — двухбуквенный код ISO 3166-1.
const COUNTRY: Array<[RegExp, string]> = [
  [/bahrain/i, 'BH'],
  [/saudi/i, 'SA'],
  [/australia/i, 'AU'],
  [/(china|chinese)/i, 'CN'],
  [/(japan|japanese)/i, 'JP'],
  [/miami/i, 'US'],
  [/(emilia|romagna|imola)/i, 'IT'],
  [/monaco/i, 'MC'],
  [/(canada|canadian)/i, 'CA'],
  [/(spain|spanish|catalunya|barcelona)/i, 'ES'],
  [/(austria|austrian)/i, 'AT'],
  [/(britain|british|silverstone)/i, 'GB'],
  [/(hungary|hungarian)/i, 'HU'],
  [/(belgium|belgian)/i, 'BE'],
  [/(netherlands|dutch)/i, 'NL'],
  [/(italy|italian|monza)/i, 'IT'],
  [/azerbaijan/i, 'AZ'],
  [/singapore/i, 'SG'],
  [/(mexico|mexican)/i, 'MX'],
  [/(brazil|brazilian|paulo)/i, 'BR'],
  [/(vegas|nevada)/i, 'US'],
  [/qatar/i, 'QA'],
  [/(abu dhabi|emirates|arab)/i, 'AE'],
  [/(united states|usa|austin|texas)/i, 'US'],
];

// Возвращает ISO-код страны или '' если не распознано.
export function raceCountry(raceName: string): string {
  for (const [re, code] of COUNTRY) {
    if (re.test(raceName)) return code;
  }
  return '';
}
