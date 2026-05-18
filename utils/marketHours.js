function getEasternParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { weekday: map.weekday, minutes: Number(map.hour) * 60 + Number(map.minute) };
}

function getMarketSession(date = new Date()) {
  const { weekday, minutes } = getEasternParts(date);
  const weekend = weekday === 'Sat' || weekday === 'Sun';
  if (weekend) return { session: 'closed', label: 'Market closed' };
  if (minutes < 4 * 60) return { session: 'closed', label: 'Market closed' };
  if (minutes < 9 * 60 + 30) return { session: 'premarket', label: 'Premarket' };
  if (minutes <= 16 * 60) return { session: 'open', label: 'Market open' };
  if (minutes <= 20 * 60) return { session: 'afterhours', label: 'After hours' };
  return { session: 'closed', label: 'Market closed' };
}

module.exports = { getMarketSession };
