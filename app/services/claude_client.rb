require "net/http"
require "json"
require "uri"

# Minimal HTTP wrapper around the Anthropic Messages API.
#
# There is no official Anthropic Ruby gem installed in this app, so this
# uses plain Net::HTTP rather than pulling in a dependency for a single
# endpoint. If the official `anthropic` Ruby gem becomes a hard
# requirement later, swap this class's internals for the gem's client and
# keep the same `call` / `chat` interface so callers do not change.
class ClaudeClient
  ENDPOINT = URI("https://api.anthropic.com/v1/messages")
  MODEL = "claude-sonnet-4-6"

  class Error < StandardError; end

  def initialize(api_key: ENV.fetch("ANTHROPIC_API_KEY", nil))
    @api_key = api_key
  end

  # Single-turn call: one user message, optional system prompt baked into it.
  def call(prompt, max_tokens: 4096)
    chat([ { role: "user", content: prompt } ], max_tokens: max_tokens)
  end

  # Multi-turn call: pass the full message history plus an optional system prompt.
  def chat(messages, system: nil, max_tokens: 4096)
    raise Error, "ANTHROPIC_API_KEY is not set" if @api_key.blank?

    body = { model: MODEL, max_tokens: max_tokens, messages: messages }
    body[:system] = system if system.present?

    request = Net::HTTP::Post.new(ENDPOINT)
    request["content-type"] = "application/json"
    request["x-api-key"] = @api_key
    request["anthropic-version"] = "2023-06-01"
    request.body = body.to_json

    response = Net::HTTP.start(ENDPOINT.host, ENDPOINT.port, use_ssl: true) do |http|
      http.request(request)
    end

    unless response.is_a?(Net::HTTPSuccess)
      raise Error, "Anthropic API request failed (#{response.code}): #{response.body.to_s.truncate(300)}"
    end

    data = JSON.parse(response.body)
    text_block = (data["content"] || []).find { |b| b["type"] == "text" }
    raise Error, "Empty response from Anthropic API" unless text_block&.dig("text").present?

    text_block["text"]
  end
end
