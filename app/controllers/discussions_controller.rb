# Handles one turn of the "discuss this revision" conversation, replacing
# the TSX prototype's direct browser-side call to the Anthropic API.
class DiscussionsController < ApplicationController
  def create
    editor = Editor.find(params.require(:editor_key))
    return render json: { error: "Unknown editor." }, status: :unprocessable_entity unless editor

    voice = editor.voice
    essay = params.require(:essay)
    revision = params.require(:revision).permit(:original, :suggested, :principle, :explanation)
    messages = params.require(:messages).map { |m| m.permit(:role, :content).to_h }

    system_prompt = <<~SYSTEM
      #{voice[:summary]}

      The full essay you are editing:
      ---
      #{essay}
      ---

      The specific revision under discussion:

      Original passage:
      "#{revision[:original]}"

      Your suggested revision:
      "#{revision[:suggested]}"

      Principle invoked: #{revision[:principle]}

      Your initial explanation: #{revision[:explanation]}

      Guidelines for this conversation:
      - Stay in character as #{voice[:name]}.
      - Be conversational, not lecturing. Like a thoughtful editor at a coffee shop.
      - Keep responses focused: 2-4 sentences typically.
      - Be willing to refine, withdraw, or strengthen your suggestion based on the writer's reasoning.
      - Be willing to push back if the writer's reasoning is wrong, kindly and clearly.
      - Reference the broader essay when useful.
      - If the writer asks for an alternative wording, propose one.
      - Use your editorial frame.
      - Do not use em-dashes. Use periods, commas, colons, or parentheses instead.
    SYSTEM

    begin
      reply = ClaudeClient.new.chat(messages, system: system_prompt)
    rescue ClaudeClient::Error => e
      return render json: { error: e.message }, status: :bad_gateway
    end

    render json: { reply: reply }
  end
end
