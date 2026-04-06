export function isLowValueQuery(query: string): boolean {
  if (!query || query.trim().length === 0) return true;

  const text = query.trim().toLowerCase();

  // Ignore single characters or very short messages unless they are specific commands
  if (text.length <= 2) return true;

  // Common conversational noise that doesn't need vector search
  const noisePatterns = [
    /^(ok|okay|sure|fine|yes|no|yep|nope|got it|understood|thanks|thank you|hello|hi|hey|good|great)$/i,
    /^ok[,\. ]*/i,
    /^sure[,\. ]*/i,
    /^好的[,。 ]*/,
    /^明白[,。 ]*/,
    /^知道[,。 ]*/,
    /^谢谢[,。 ]*/,
    /^可以[,。 ]*/,
    /^没问题[,。 ]*/,
    /^嗯[,。 ]*/,
    /^对[,。 ]*/,
    /^行[,。 ]*/,
  ];

  // Regex to detect purely emoji strings
  const emojiRegex =
    /^[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\s]+$/u;

  if (emojiRegex.test(text)) return true;

  for (const pattern of noisePatterns) {
    if (pattern.test(text)) return true;
  }

  // Basic length heuristics
  // Chinese text tends to be shorter but contains more meaning per char
  const hasCJK = /[\u4e00-\u9fa5]/.test(text);
  if (hasCJK && text.length < 4) return true;
  if (!hasCJK && text.length < 10) return true;

  return false;
}

export function shouldCapture(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  if (isLowValueQuery(text)) return false;
  return true;
}

export function filterNoise<T>(
  items: T[],
  textExtractor: (item: T) => string,
): T[] {
  return items.filter((item) => {
    const text = textExtractor(item);
    return !isLowValueQuery(text);
  });
}
