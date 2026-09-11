import { describe, expect, it } from 'vitest';
import { parseYouTubeInput } from './youtube';

describe('parseYouTubeInput', () => {
  it('normalizes watch URLs', () => {
    expect(parseYouTubeInput('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=abc')).toEqual({
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
  });

  it('accepts youtu.be and direct video IDs', () => {
    expect(parseYouTubeInput('https://youtu.be/dQw4w9WgXcQ?t=42')?.videoId).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeInput('dQw4w9WgXcQ', { allowVideoId: true })?.url).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('accepts shorts, live and embed URLs', () => {
    expect(parseYouTubeInput('https://youtube.com/shorts/dQw4w9WgXcQ')?.videoId).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeInput('https://www.youtube.com/live/dQw4w9WgXcQ')?.videoId).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeInput('https://www.youtube.com/embed/dQw4w9WgXcQ')?.videoId).toBe('dQw4w9WgXcQ');
  });

  it('rejects playlist-only URLs and unrelated text', () => {
    expect(parseYouTubeInput('https://www.youtube.com/playlist?list=abc')).toBeNull();
    expect(parseYouTubeInput('Oliver Heldens live set')).toBeNull();
  });
});

describe('search text versus explicit links', () => {
  it.each(['Extremoduro', 'Radioheadds', 'abcdefghijk', 'dQw4w9WgXcQ', 'Extremoduro canciones'])(
    'keeps %s as a query', (query) => expect(parseYouTubeInput(query)).toBeNull(),
  );
  it.each([
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',
    'https://evil.test/watch?v=dQw4w9WgXcQ',
    'https://youtube.com/anything?v=dQw4w9WgXcQ',
    'https://user@youtube.com/watch?v=dQw4w9WgXcQ',
  ])('rejects unrelated or malformed URL %s', (url) => expect(parseYouTubeInput(url)).toBeNull());
  it('accepts Music and mobile watch links', () => {
    for (const host of ['music.youtube.com', 'm.youtube.com']) {
      expect(parseYouTubeInput(`https://${host}/watch?v=dQw4w9WgXcQ`)?.videoId).toBe('dQw4w9WgXcQ');
    }
  });
});
