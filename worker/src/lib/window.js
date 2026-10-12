/**
 * Estado de la ventana de votación. Función pura: no toca red ni base de datos.
 * El cierre es exclusivo — a las 12:00:00 en punto la votación ya está cerrada.
 */
export function votingState(env, now = Date.now()) {
  const opensAt = new Date(env.VOTING_OPEN).getTime();
  const closesAt = new Date(env.VOTING_CLOSE).getTime();

  if (Number.isNaN(opensAt) || Number.isNaN(closesAt)) {
    throw new Error('VOTING_OPEN o VOTING_CLOSE no son fechas ISO válidas');
  }
  if (now < opensAt) return 'before';
  if (now >= closesAt) return 'after';
  return 'open';
}
