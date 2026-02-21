import { query } from '@anthropic-ai/claude-agent-sdk';

const SYSTEM_PROMPT = `You are a passionate cinephile and expert movie curator. Your mission is to help people discover films they'll truly love by deeply understanding their unique taste through their favorite movies and personal preferences.

Your deep research methodology:
1. For EACH favorite movie the user provides, use WebSearch to find professional reviews, critical essays, and analyses. Then use WebFetch to actually read those pages and extract rich details about themes, cinematography, acting style, narrative structure, emotional tone, pacing, and cultural context.
2. Cross-reference what the user explicitly says they love with what critics and fans identify as the film's defining qualities.
3. Build a precise, nuanced taste profile that captures the subtle qualities this person gravitates toward.
4. Search broadly for films matching this profile — explore different eras, countries, genres, and directors.
5. For each serious candidate, use WebSearch and WebFetch to read actual reviews and confirm it's a genuine match for the user's specific taste.
6. Present your final 8-12 recommendations with detailed, personal explanations tying each film back to the user's stated preferences.

Research sources to use: Rotten Tomatoes, IMDb, Roger Ebert's site (rogerebert.com), Letterboxd, The Guardian Film section, A.V. Club, Sight & Sound, Criterion Collection essays, and scholarly film analysis.

Format your final recommendations clearly with:
- Movie title and year
- Director
- A brief synopsis (2-3 sentences)
- Why YOU specifically recommend it for THIS user (tied to their stated preferences)
- What critics say about it (with a standout quote if you found one)`;

export async function* runMovieAgent(favoriteMovies, moviePreferences) {
  const moviesContext = favoriteMovies
    .map((movie, i) => {
      const prefs = moviePreferences[movie];
      if (prefs && prefs.trim()) {
        return `${i + 1}. "${movie}"\n   What I love about it: ${prefs.trim()}`;
      }
      return `${i + 1}. "${movie}"\n   (No specific preference noted)`;
    })
    .join('\n\n');

  const prompt = `Here are my favorite movies and what I specifically love about each one:

${moviesContext}

Please deeply research these films and my stated preferences, then find movies I would truly love. Your research should:

1. Search for and READ reviews/analyses of each of my favorite movies to understand their deeper qualities
2. Identify the specific patterns in what I love — not just genre, but tone, themes, style, emotional resonance
3. Search extensively for films that match my taste profile across all eras and countries
4. Read actual reviews of your candidate recommendations to validate they're genuine matches
5. Return a curated list of 8-12 recommendations with detailed, personalized explanations

Be thorough — I want recommendations that truly get what I love about movies, not just surface-level genre matches.`;

  for await (const message of query({
    prompt,
    options: {
      systemPrompt: SYSTEM_PROMPT,
      tools: ['WebSearch', 'WebFetch'],
      allowedTools: ['WebSearch', 'WebFetch'],
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      model: 'claude-opus-4-6',
      thinking: { type: 'adaptive' },
      effort: 'high',
      maxTurns: 60,
      persistSession: false,
      cwd: process.cwd(),
    },
  })) {
    yield message;
  }
}
