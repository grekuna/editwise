class SynthesisController < ApplicationController
  def create
    essay  = params.require(:essay)
    passes = params.require(:passes)

    user_content = SynthesisPrompt.user(essay, passes)

    synthesis = ClaudeClient.new.chat(
      [ { role: "user", content: user_content } ],
      system: SynthesisPrompt.system,
      max_tokens: 4096
    )

    render json: { synthesis: synthesis }
  rescue ActionController::ParameterMissing => e
    render json: { error: e.message }, status: :bad_request
  rescue ClaudeClient::Error => e
    render json: { error: e.message }, status: :bad_gateway
  end
end
