require "test_helper"

class PassResponseTest < ActiveSupport::TestCase
  ESSAY = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs."

  def valid_json(verdict: "Strong overall.", revisions: [])
    JSON.generate({ verdict: verdict, revisions: revisions })
  end

  def revision(original: "The quick brown fox", suggested: "A swift auburn fox", principle: "clarity", explanation: "More precise.")
    { "original" => original, "suggested" => suggested, "principle" => principle, "explanation" => explanation }
  end

  # ---------------------------------------------------------------------------
  # RED: basic happy path
  # ---------------------------------------------------------------------------

  test "returns verdict from JSON" do
    result = PassResponse.parse(valid_json(verdict: "Solid prose."), ESSAY)
    assert_equal "Solid prose.", result.verdict
  end

  test "returns empty verdict when JSON verdict is empty string" do
    result = PassResponse.parse(valid_json(verdict: ""), ESSAY)
    assert_equal "", result.verdict
  end

  test "returns revisions whose original is verbatim in the essay" do
    r = revision(original: "The quick brown fox")
    result = PassResponse.parse(valid_json(revisions: [r]), ESSAY)
    assert_equal 1, result.revisions.length
    assert_equal "The quick brown fox", result.revisions.first.original
    assert_equal "A swift auburn fox", result.revisions.first.suggested
  end

  test "drops revisions whose original is not in the essay" do
    r = revision(original: "This text is not in the essay at all")
    result = PassResponse.parse(valid_json(revisions: [r]), ESSAY)
    assert_empty result.revisions
  end

  test "sorts revisions by their position in the essay" do
    r1 = revision(original: "Pack my box", suggested: "Fill my box", principle: "clarity", explanation: "Stronger verb.")
    r2 = revision(original: "The quick brown fox", suggested: "A swift fox", principle: "brevity", explanation: "Shorter.")
    result = PassResponse.parse(valid_json(revisions: [r1, r2]), ESSAY)
    assert_equal "The quick brown fox", result.revisions[0].original
    assert_equal "Pack my box", result.revisions[1].original
  end

  test "assigns each revision a unique id" do
    r1 = revision(original: "The quick brown fox")
    r2 = revision(original: "Pack my box", suggested: "Fill my box", principle: "brevity", explanation: "x")
    result = PassResponse.parse(valid_json(revisions: [r1, r2]), ESSAY)
    ids = result.revisions.map(&:id)
    assert_equal ids.uniq, ids
  end

  test "defaults principle to 'note' when missing from JSON" do
    r = { "original" => "The quick brown fox", "suggested" => "A swift fox", "explanation" => "x" }
    result = PassResponse.parse(valid_json(revisions: [r]), ESSAY)
    assert_equal "note", result.revisions.first.principle
  end

  test "defaults explanation to empty string when missing from JSON" do
    r = { "original" => "The quick brown fox", "suggested" => "A swift fox", "principle" => "clarity" }
    result = PassResponse.parse(valid_json(revisions: [r]), ESSAY)
    assert_equal "", result.revisions.first.explanation
  end

  # ---------------------------------------------------------------------------
  # RED: fence stripping
  # ---------------------------------------------------------------------------

  test "strips ```json fences before parsing" do
    wrapped = "```json\n#{valid_json(verdict: 'Good.')}\n```"
    result = PassResponse.parse(wrapped, ESSAY)
    assert_equal "Good.", result.verdict
  end

  test "strips plain ``` fences before parsing" do
    wrapped = "```\n#{valid_json(verdict: 'Fine.')}\n```"
    result = PassResponse.parse(wrapped, ESSAY)
    assert_equal "Fine.", result.verdict
  end

  test "handles preamble text before the JSON object" do
    preamble = "Here is my analysis:\n\n#{valid_json(verdict: 'Decent.')}"
    result = PassResponse.parse(preamble, ESSAY)
    assert_equal "Decent.", result.verdict
  end

  # ---------------------------------------------------------------------------
  # RED: error paths
  # ---------------------------------------------------------------------------

  test "raises ArgumentError when response contains no JSON object" do
    assert_raises(ArgumentError) { PassResponse.parse("No JSON here at all.", ESSAY) }
  end

  test "raises JSON::ParserError when JSON has braces but is malformed" do
    assert_raises(JSON::ParserError) { PassResponse.parse('{"verdict": "ok", "revisions": [}', ESSAY) }
  end

  test "returns empty revisions when revisions key is missing from JSON" do
    result = PassResponse.parse(JSON.generate({ verdict: "OK" }), ESSAY)
    assert_empty result.revisions
  end

  test "returns empty revisions when revisions is not an array" do
    result = PassResponse.parse(JSON.generate({ verdict: "OK", revisions: "nope" }), ESSAY)
    assert_empty result.revisions
  end

  test "skips revision entries that are not hashes" do
    raw = JSON.generate({ verdict: "OK", revisions: ["a string", 42, revision(original: "The quick brown fox")] })
    result = PassResponse.parse(raw, ESSAY)
    assert_equal 1, result.revisions.length
  end

  # ---------------------------------------------------------------------------
  # RED: as_json shape
  # ---------------------------------------------------------------------------

  test "revision as_json includes status: pending and nil userEdit" do
    r = revision(original: "The quick brown fox")
    result = PassResponse.parse(valid_json(revisions: [r]), ESSAY)
    json = result.revisions.first.as_json
    assert_equal "pending", json[:status]
    assert_nil json[:userEdit]
  end
end
