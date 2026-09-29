/*
 * Timezone catalog — the list and order shown in the chart-controls-bar
 * timezone menu (`[data-name="time-zone-menu"]`).
 *
 * Each entry pairs the visible label (what the popup row prints, verbatim)
 * with an IANA timezone name so the bottom-bar wall clock can format the time
 * via `Intl.DateTimeFormat(...).format()`.  The UTC-offset prefix is fixed
 * text per row — we don't try to recompute it from the offset (that would
 * change with DST).  The wall-clock string is derived from the IANA timezone,
 * so DST is still correct.
 *
 * Special rows:
 *   "UTC"      → IANA "UTC"
 *   "Exchange" → IANA varies per symbol; in this mock it falls back to the
 *                user's local zone since we don't model per-symbol exchange
 *                metadata.
 */
export type TimezoneEntry = {
  /** The literal label shown in the popup row.  Treat as opaque. */
  label: string;
  /** IANA name passed to `Intl.DateTimeFormat({ timeZone: ... })`. */
  iana: string;
};

export const TIMEZONES: readonly TimezoneEntry[] = [
  { label: 'UTC',                          iana: 'UTC' },
  { label: 'Exchange',                     iana: 'America/New_York' },
  { label: '(UTC-10) Honolulu',            iana: 'Pacific/Honolulu' },
  { label: '(UTC-8) Anchorage',            iana: 'America/Anchorage' },
  { label: '(UTC-8) Juneau',               iana: 'America/Juneau' },
  { label: '(UTC-7) Los Angeles',          iana: 'America/Los_Angeles' },
  { label: '(UTC-7) Phoenix',              iana: 'America/Phoenix' },
  { label: '(UTC-7) Vancouver',            iana: 'America/Vancouver' },
  { label: '(UTC-6) Denver',               iana: 'America/Denver' },
  { label: '(UTC-6) Mexico City',          iana: 'America/Mexico_City' },
  { label: '(UTC-6) San Salvador',         iana: 'America/El_Salvador' },
  { label: '(UTC-5) Bogota',               iana: 'America/Bogota' },
  { label: '(UTC-5) Chicago',              iana: 'America/Chicago' },
  { label: '(UTC-5) Lima',                 iana: 'America/Lima' },
  { label: '(UTC-4) Caracas',              iana: 'America/Caracas' },
  { label: '(UTC-4) New York',             iana: 'America/New_York' },
  { label: '(UTC-4) Santiago',             iana: 'America/Santiago' },
  { label: '(UTC-4) Toronto',              iana: 'America/Toronto' },
  { label: '(UTC-3) Buenos Aires',         iana: 'America/Argentina/Buenos_Aires' },
  { label: '(UTC-3) Halifax',              iana: 'America/Halifax' },
  { label: '(UTC-3) Sao Paulo',            iana: 'America/Sao_Paulo' },
  { label: '(UTC) Azores',                 iana: 'Atlantic/Azores' },
  { label: '(UTC) Reykjavik',              iana: 'Atlantic/Reykjavik' },
  { label: '(UTC+1) Casablanca',           iana: 'Africa/Casablanca' },
  { label: '(UTC+1) Dublin',               iana: 'Europe/Dublin' },
  { label: '(UTC+1) Lagos',                iana: 'Africa/Lagos' },
  { label: '(UTC+1) Lisbon',               iana: 'Europe/Lisbon' },
  { label: '(UTC+1) London',               iana: 'Europe/London' },
  { label: '(UTC+1) Tunis',                iana: 'Africa/Tunis' },
  { label: '(UTC+2) Amsterdam',            iana: 'Europe/Amsterdam' },
  { label: '(UTC+2) Belgrade',             iana: 'Europe/Belgrade' },
  { label: '(UTC+2) Berlin',               iana: 'Europe/Berlin' },
  { label: '(UTC+2) Bratislava',           iana: 'Europe/Bratislava' },
  { label: '(UTC+2) Brussels',             iana: 'Europe/Brussels' },
  { label: '(UTC+2) Budapest',             iana: 'Europe/Budapest' },
  { label: '(UTC+2) Copenhagen',           iana: 'Europe/Copenhagen' },
  { label: '(UTC+2) Johannesburg',         iana: 'Africa/Johannesburg' },
  { label: '(UTC+2) Ljubljana',            iana: 'Europe/Ljubljana' },
  { label: '(UTC+2) Luxembourg',           iana: 'Europe/Luxembourg' },
  { label: '(UTC+2) Madrid',               iana: 'Europe/Madrid' },
  { label: '(UTC+2) Malta',                iana: 'Europe/Malta' },
  { label: '(UTC+2) Oslo',                 iana: 'Europe/Oslo' },
  { label: '(UTC+2) Paris',                iana: 'Europe/Paris' },
  { label: '(UTC+2) Prague',               iana: 'Europe/Prague' },
  { label: '(UTC+2) Rome',                 iana: 'Europe/Rome' },
  { label: '(UTC+2) Stockholm',            iana: 'Europe/Stockholm' },
  { label: '(UTC+2) Vienna',               iana: 'Europe/Vienna' },
  { label: '(UTC+2) Warsaw',               iana: 'Europe/Warsaw' },
  { label: '(UTC+2) Zagreb',               iana: 'Europe/Zagreb' },
  { label: '(UTC+2) Zurich',               iana: 'Europe/Zurich' },
  { label: '(UTC+3) Athens',               iana: 'Europe/Athens' },
  { label: '(UTC+3) Bahrain',              iana: 'Asia/Bahrain' },
  { label: '(UTC+3) Bucharest',            iana: 'Europe/Bucharest' },
  { label: '(UTC+3) Cairo',                iana: 'Africa/Cairo' },
  { label: '(UTC+3) Helsinki',             iana: 'Europe/Helsinki' },
  { label: '(UTC+3) Istanbul',             iana: 'Europe/Istanbul' },
  { label: '(UTC+3) Jerusalem',            iana: 'Asia/Jerusalem' },
  { label: '(UTC+3) Kuwait',               iana: 'Asia/Kuwait' },
  { label: '(UTC+3) Moscow',               iana: 'Europe/Moscow' },
  { label: '(UTC+3) Nairobi',              iana: 'Africa/Nairobi' },
  { label: '(UTC+3) Nicosia',              iana: 'Asia/Nicosia' },
  { label: '(UTC+3) Qatar',                iana: 'Asia/Qatar' },
  { label: '(UTC+3) Riga',                 iana: 'Europe/Riga' },
  { label: '(UTC+3) Riyadh',               iana: 'Asia/Riyadh' },
  { label: '(UTC+3) Sofia',                iana: 'Europe/Sofia' },
  { label: '(UTC+3) Tallinn',              iana: 'Europe/Tallinn' },
  { label: '(UTC+3) Vilnius',              iana: 'Europe/Vilnius' },
  { label: '(UTC+3:30) Tehran',            iana: 'Asia/Tehran' },
  { label: '(UTC+4) Dubai',                iana: 'Asia/Dubai' },
  { label: '(UTC+4) Muscat',               iana: 'Asia/Muscat' },
  { label: '(UTC+4:30) Kabul',             iana: 'Asia/Kabul' },
  { label: '(UTC+5) Ashgabat',             iana: 'Asia/Ashgabat' },
  { label: '(UTC+5) Astana',               iana: 'Asia/Almaty' },
  { label: '(UTC+5) Karachi',              iana: 'Asia/Karachi' },
  { label: '(UTC+5:30) Colombo',           iana: 'Asia/Colombo' },
  { label: '(UTC+5:30) Kolkata',           iana: 'Asia/Kolkata' },
  { label: '(UTC+5:45) Kathmandu',         iana: 'Asia/Kathmandu' },
  { label: '(UTC+6) Dhaka',                iana: 'Asia/Dhaka' },
  { label: '(UTC+6:30) Yangon',            iana: 'Asia/Yangon' },
  { label: '(UTC+7) Bangkok',              iana: 'Asia/Bangkok' },
  { label: '(UTC+7) Ho Chi Minh',          iana: 'Asia/Ho_Chi_Minh' },
  { label: '(UTC+7) Jakarta',              iana: 'Asia/Jakarta' },
  { label: '(UTC+8) Chongqing',            iana: 'Asia/Shanghai' },
  { label: '(UTC+8) Hong Kong',            iana: 'Asia/Hong_Kong' },
  { label: '(UTC+8) Kuala Lumpur',         iana: 'Asia/Kuala_Lumpur' },
  { label: '(UTC+8) Manila',               iana: 'Asia/Manila' },
  { label: '(UTC+8) Perth',                iana: 'Australia/Perth' },
  { label: '(UTC+8) Shanghai',             iana: 'Asia/Shanghai' },
  { label: '(UTC+8) Singapore',            iana: 'Asia/Singapore' },
  { label: '(UTC+8) Taipei',               iana: 'Asia/Taipei' },
  { label: '(UTC+9) Seoul',                iana: 'Asia/Seoul' },
  { label: '(UTC+9) Tokyo',                iana: 'Asia/Tokyo' },
  { label: '(UTC+9:30) Adelaide',          iana: 'Australia/Adelaide' },
  { label: '(UTC+10) Brisbane',            iana: 'Australia/Brisbane' },
  { label: '(UTC+10) Sydney',              iana: 'Australia/Sydney' },
  { label: '(UTC+11) Norfolk Island',      iana: 'Pacific/Norfolk' },
  { label: '(UTC+12) New Zealand',         iana: 'Pacific/Auckland' },
  { label: '(UTC+12:45) Chatham Islands',  iana: 'Pacific/Chatham' },
  { label: '(UTC+13) Tokelau',             iana: 'Pacific/Fakaofo' },
];

/** Initial pick. */
export const DEFAULT_TIMEZONE_LABEL = '(UTC-4) New York';

export function findTimezone(label: string): TimezoneEntry | undefined {
  return TIMEZONES.find((t) => t.label === label);
}
