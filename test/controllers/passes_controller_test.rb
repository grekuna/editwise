require "test_helper"

class PassesControllerTest < ActionDispatch::IntegrationTest
  ESSAY = "The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs."

  def valid_claude_response(original: "The quick brown fox")
    JSON.generate({
      verdict: "Solid flow overall.",
      revisions: [{
        original: original,
        suggested: "A swift fox",
        principle: "clarity",
        explanation: "More direct."
      }]
    })
  end

  # ---------------------------------------------------------------------------
  # RED: happy path
  # ---------------------------------------------------------------------------

  test "returns verdict and revisions on success" do
    ClaudeClient.any_instance.stubs(:call).returns(valid_claude_response)
    post passes_path, params: { editor_key: "williams", essay: ESSAY }, as: :json
    assert_response :ok
    body = response.parsed_body
    assert_equal "Solid flow overall.", body["verdict"]
    assert_equal 1, body["revisions"].length
    assert_equal "The quick brown fox", body["revisions"][0]["original"]
    assert_equal "pending", body["revisions"][0]["status"]
  end

  # ---------------------------------------------------------------------------
  # RED: validation errors
  # ---------------------------------------------------------------------------

  test "returns 422 for unknown editor key" do
    post passes_path, params: { editor_key: "nobody", essay: ESSAY }, as: :json
    assert_response :unprocessable_entity
    assert_match "Unknown editor", response.parsed_body["error"]
  end

  test "returns 400 when essay param is missing" do
    post passes_path, params: { editor_key: "williams" }, as: :json
    assert_response :bad_request
  end

  # ---------------------------------------------------------------------------
  # RED: Claude API error handling
  # ---------------------------------------------------------------------------

  test "returns 502 when Claude API raises an error" do
    ClaudeClient.any_instance.stubs(:call).raises(ClaudeClient::Error, "API down")
    post passes_path, params: { editor_key: "williams", essay: ESSAY }, as: :json
    assert_response :bad_gateway
    assert_match "API down", response.parsed_body["error"]
  end

  test "returns 422 when Claude response cannot be parsed as JSON" do
    ClaudeClient.any_instance.stubs(:call).returns("not json at all")
    post passes_path, params: { editor_key: "williams", essay: ESSAY }, as: :json
    assert_response :unprocessable_entity
    assert_match "Could not parse", response.parsed_body["error"]
  end

  test "returns 422 when Claude returns empty revisions and no verdict" do
    empty = JSON.generate({ verdict: "", revisions: [] })
    ClaudeClient.any_instance.stubs(:call).returns(empty)
    post passes_path, params: { editor_key: "williams", essay: ESSAY }, as: :json
    assert_response :unprocessable_entity
    assert_match "Nothing parsed", response.parsed_body["error"]
  end

  # ---------------------------------------------------------------------------
  # RED: revision filtering
  # ---------------------------------------------------------------------------

  test "filters out revisions whose original is not in the essay" do
    response_with_bad_revision = JSON.generate({
      verdict: "OK",
      revisions: [
        { original: "not in the essay", suggested: "x", principle: "y", explanation: "z" },
        { original: "The quick brown fox", suggested: "A swift fox", principle: "clarity", explanation: "Better." }
      ]
    })
    ClaudeClient.any_instance.stubs(:call).returns(response_with_bad_revision)
    post passes_path, params: { editor_key: "williams", essay: ESSAY }, as: :json
    assert_response :ok
    assert_equal 1, response.parsed_body["revisions"].length
    assert_equal "The quick brown fox", response.parsed_body["revisions"][0]["original"]
  end
end
