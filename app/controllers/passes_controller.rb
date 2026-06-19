# Runs one editor pass over an essay via the Claude API.
#
# This replaces the TSX prototype's direct `fetch('https://api.anthropic.com/...')`
# call from the browser. The frontend now calls this Rails endpoint instead,
# so the Anthropic API key never reaches client-side JavaScript.
class PassesController < ApplicationController
  def create
    editor = Editor.find(params.require(:editor_key))
    return render json: { error: "Unknown editor." }, status: :unprocessable_entity unless editor

    essay = params.require(:essay)

    begin
      raw_text = ClaudeClient.new.call(editor.prompt + essay)
      result = PassResponse.parse(raw_text, essay)
    rescue ClaudeClient::Error => e
      return render json: { error: e.message }, status: :bad_gateway
    rescue JSON::ParserError, ArgumentError
      return render json: { error: "Could not parse the editor's response. Try again." }, status: :unprocessable_entity
    end

    if result.revisions.empty? && result.verdict.blank?
      return render json: { error: "Nothing parsed from the response. Try again or pick a different editor." }, status: :unprocessable_entity
    end

    render json: { verdict: result.verdict, revisions: result.revisions }
  end
end
