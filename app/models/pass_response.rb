# Parses and validates the JSON a Claude pass returns: a verdict string
# plus an array of revision objects. Port of the TSX `parsePassResponse`.
#
# Each revision's "original" text must be a verbatim, findable substring
# of the essay; revisions that fail this check are dropped, since the
# frontend highlights revisions by locating their original text inline.
class PassResponse
  Revision = Struct.new(:id, :original, :suggested, :principle, :explanation, keyword_init: true) do
    def as_json(*)
      { id: id, original: original, suggested: suggested, principle: principle, explanation: explanation, status: "pending", userEdit: nil }
    end
  end

  attr_reader :verdict, :revisions

  def initialize(verdict:, revisions:)
    @verdict = verdict
    @revisions = revisions
  end

  def self.parse(text, essay)
    cleaned = text.gsub(/```json/i, "").gsub("```", "").strip
    start = cleaned.index("{")
    finish = cleaned.rindex("}")
    raise ArgumentError, "Response did not contain a JSON object." if start.nil? || finish.nil?

    parsed = JSON.parse(cleaned[start..finish])

    verdict = parsed["verdict"].is_a?(String) ? parsed["verdict"].strip : ""
    raw_revisions = parsed["revisions"].is_a?(Array) ? parsed["revisions"] : []

    validated = raw_revisions
      .select { |r| r.is_a?(Hash) && r["original"].is_a?(String) && r["suggested"].is_a?(String) }
      .select { |r| essay.include?(r["original"]) }
      .sort_by { |r| essay.index(r["original"]) }
      .each_with_index.map do |r, i|
        Revision.new(
          id: "r#{i}-#{Time.now.to_i}",
          original: r["original"],
          suggested: r["suggested"],
          principle: r["principle"].presence || "note",
          explanation: r["explanation"].presence || ""
        )
      end

    new(verdict: verdict, revisions: validated)
  end
end
