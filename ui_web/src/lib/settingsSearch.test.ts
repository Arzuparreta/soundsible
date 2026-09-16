import { describe, expect, it } from 'vitest';
import { editDistance, highlightRanges, rankDocs, type SearchDoc, type SearchField } from './settingsSearch';

function doc(label: string, fields: SearchField[] = []): SearchDoc<string> {
  return { value: label, label, fields };
}

function labels(docs: SearchDoc<string>[], query: string): string[] | null {
  return rankDocs(docs, query)?.map((hit) => hit.value) ?? null;
}

describe('settings search matching', () => {
  it('distinguishes "not searching" from "nothing matched"', () => {
    expect(rankDocs([doc('Tema')], '   ')).toBeNull();
    expect(rankDocs([doc('Tema')], '¿?')).toBeNull();
    expect(rankDocs([doc('Tema')], 'podcasts')).toEqual([]);
  });

  it('ignores accents and case', () => {
    expect(labels([doc('Reproducción'), doc('Descargas')], 'REPRODUCCION')).toEqual(['Reproducción']);
    expect(labels([doc('Cambiar contraseña')], 'contrasena')).toEqual(['Cambiar contraseña']);
  });

  it('needs every word, in any order', () => {
    const docs = [doc('Igualar el volumen entre canciones'), doc('Volumen del sistema')];

    expect(labels(docs, 'volumen igualar')).toEqual(['Igualar el volumen entre canciones']);
    expect(labels(docs, 'volumen idioma')).toEqual([]);
  });

  it('ranks a whole word over the start of one over the inside of one', () => {
    const docs = [doc('Sistema'), doc('Temas adicionales'), doc('Tema')];

    expect(labels(docs, 'tema')).toEqual(['Tema', 'Temas adicionales', 'Sistema']);
  });

  it('finds a word from its first letters while it is still being typed', () => {
    expect(labels([doc('Vibración (hápticos)')], 'vib')).toEqual(['Vibración (hápticos)']);
  });

  it('forgives a typo in labels and synonyms, but not in explanatory notes', () => {
    const docs = [
      doc('Igualar el volumen entre canciones'),
      doc('Cambiar contraseña'),
      doc('Reproducción automática', [{ text: 'Sigue sonando a un volumen parecido', weight: 6 }]),
    ];

    expect(labels(docs, 'volumne')).toEqual(['Igualar el volumen entre canciones']);
    expect(labels(docs, 'contrasña')).toEqual(['Cambiar contraseña']);
    expect(labels(docs, 'igulaar')).toEqual(['Igualar el volumen entre canciones']);
    expect(labels(docs, 'qxzv')).toEqual([]);
  });

  it('does not stretch a short word into a typo', () => {
    expect(labels([doc('Red local')], 'rex')).toEqual([]);
  });

  it('ranks the label above a synonym, and a synonym above a note', () => {
    const docs = [
      doc('Contraste reforzado', [{ text: 'Hace el tema más legible', weight: 6 }]),
      doc('Apariencia', [{ text: 'modo oscuro, tema', weight: 2 }]),
      doc('Tema'),
    ];

    expect(labels(docs, 'tema')).toEqual(['Tema', 'Apariencia', 'Contraste reforzado']);
  });

  it('lets a filler word through without letting it decide anything', () => {
    const docs = [doc('Tema'), doc('Idioma')];

    expect(labels(docs, 'el tema')).toEqual(['Tema']);
    // On its own, a short word is the whole query and has to match.
    expect(labels(docs, 'id')).toEqual(['Idioma']);
    expect(labels(docs, 'el')).toEqual([]);
  });

  it('matches any fragment of Han text, which has no spaces', () => {
    expect(labels([doc('音量均衡'), doc('主题')], '均衡')).toEqual(['音量均衡']);
    expect(rankDocs([doc('音量均衡')], '均衡')?.[0].ranges).toEqual([[2, 4]]);
  });

  it('puts the label that is exactly the query first', () => {
    expect(labels([doc('Estado del motor'), doc('Estado')], 'estado')).toEqual([
      'Estado',
      'Estado del motor',
    ]);
  });

  it('keeps registry order between equal matches', () => {
    expect(labels([doc('Estado del motor'), doc('Estado de la red')], 'estado')).toEqual([
      'Estado del motor',
      'Estado de la red',
    ]);
  });
});

describe('settings search highlighting', () => {
  it('points at the original text, accents included', () => {
    expect(rankDocs([doc('Reproducción')], 'reproduc')?.[0].ranges).toEqual([[0, 8]]);
    expect(highlightRanges('Reproducción automática', ['automatica'])).toEqual([[13, 23]]);
  });

  it('prefers the start of a word and merges what overlaps', () => {
    expect(highlightRanges('Auto-actualizar yt-dlp', ['dlp'])).toEqual([[19, 22]]);
    expect(highlightRanges('Sistema de temas', ['tema'])).toEqual([[11, 15]]);
    expect(highlightRanges('Igualar el volumen', ['igual', 'igualar'])).toEqual([[0, 7]]);
  });

  it('never marks a short fragment inside a word', () => {
    expect(highlightRanges('Reproducción automática', ['to'])).toEqual([]);
  });

  it('has nothing to mark for a word matched only elsewhere', () => {
    expect(rankDocs([doc('Apariencia', [{ text: 'modo oscuro', weight: 2 }])], 'oscuro')?.[0].ranges).toEqual(
      [],
    );
  });
});

describe('edit distance', () => {
  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('volumne', 'volumen', 2)).toBe(1);
    expect(editDistance('contrasna', 'contrasena', 2)).toBe(1);
    expect(editDistance('tema', 'idioma', 1)).toBe(2);
  });
});
