export function buildQuoteText(
	originalText: string,
	from: string,
	date: string,
): string {
	const lines = originalText.split("\n").map((l) => `> ${l}`);
	return `\n\nOn ${date}, ${from} wrote:\n${lines.join("\n")}`;
}

export function ensureReSubject(subject: string | null | undefined): string {
	const s = subject ?? "";
	if (/^re:/i.test(s.trim())) return s.trim();
	return `Re: ${s.trim()}`;
}

export function formatAddress(
	name: string | undefined,
	address: string,
): string {
	if (name && name !== address) return `"${name}" <${address}>`;
	return address;
}

export function parseAddressList(raw: string | null | undefined): string[] {
	if (!raw) return [];
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}
