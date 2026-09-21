import { describe, it, expect } from 'vitest';
import { votingState } from '../src/lib/window.js';

const env = {
  VOTING_OPEN: '2026-10-11T10:00:00+02:00',
  VOTING_CLOSE: '2026-10-17T12:00:00+02:00'
};

const at = (iso) => new Date(iso).getTime();

describe('votingState', () => {
  it('devuelve "before" antes de la apertura', () => {
    expect(votingState(env, at('2026-10-11T09:59:59+02:00'))).toBe('before');
  });

  it('devuelve "open" justo en el instante de apertura', () => {
    expect(votingState(env, at('2026-10-11T10:00:00+02:00'))).toBe('open');
  });

  it('devuelve "open" a mitad de la ventana', () => {
    expect(votingState(env, at('2026-10-14T12:00:00+02:00'))).toBe('open');
  });

  it('devuelve "after" justo en el instante de cierre', () => {
    expect(votingState(env, at('2026-10-17T12:00:00+02:00'))).toBe('after');
  });

  it('respeta el desfase horario, no la hora local', () => {
    // 08:30 UTC = 10:30 en Madrid → ya abierta
    expect(votingState(env, at('2026-10-11T08:30:00Z'))).toBe('open');
    // 07:30 UTC = 09:30 en Madrid → aún cerrada
    expect(votingState(env, at('2026-10-11T07:30:00Z'))).toBe('before');
  });

  it('lanza error si las fechas de configuración no son válidas', () => {
    expect(() => votingState({ VOTING_OPEN: 'ayer', VOTING_CLOSE: 'mañana' }, 0)).toThrow();
  });
});
