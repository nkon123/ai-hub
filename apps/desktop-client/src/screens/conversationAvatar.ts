// 대화 목록 왼쪽의 동그라미(아바타) — 제목의 첫 글자와 대화마다 고정된 색.
// 색은 대화 id 로만 정해서, 목록이 다시 그려지거나 순서가 바뀌어도 같은 대화는 늘
// 같은 색이다. 클래스 이름은 Tailwind 가 소스에서 그대로 찾아야 해서 전부 리터럴이다.

const TONES = [
  "bg-sky-100 text-sky-700",
  "bg-emerald-100 text-emerald-700",
  "bg-violet-100 text-violet-700",
  "bg-amber-100 text-amber-700",
  "bg-rose-100 text-rose-700",
  "bg-teal-100 text-teal-700",
] as const;

/** 제목의 첫 글자. 글자·숫자가 하나도 없으면 `#` 을 쓴다. */
export function avatarInitial(title: string): string {
  for (const ch of title.trim()) {
    if (/[\p{L}\p{N}]/u.test(ch)) return ch.toUpperCase();
  }
  return "#";
}

/** 같은 id 는 언제나 같은 색 조합(배경+글자)을 돌려준다. */
export function avatarTone(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return TONES[hash % TONES.length];
}
