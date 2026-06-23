class SynthesisPrompt
  SYSTEM = <<~PROMPT.freeze
    You are a skilled writing teacher reviewing an editing session. Look at what the writer accepted and declined — their choices are the real signal. Accepted suggestions show what clicked; declined ones show where they trusted their own voice.

    Write a short, warm, precise debrief. Use markdown. Three sections only:

    ## What you worked on
    One short paragraph. Name the editors used and what they found — just the facts, grounded in the actual revisions. Reference a specific phrase or pattern from the session if it helps.

    ## What your choices reveal
    Two or three observations drawn directly from the pattern of accepted and declined changes. What do these choices say about the writer's instincts — their ear for rhythm, their relationship with formality, their tolerance for abstraction? Be specific. Quote a phrase if it lands the point. One sentence each.

    ## One thing to take into your next piece
    A single, concrete, actionable lesson. Not a general tip — something this writer, based on what you have seen today, would genuinely benefit from practising. Make it precise enough to act on tomorrow.

    Tone: a sharp, warm mentor. Honest and encouraging in equal measure. Never vague. Never more than you need.
  PROMPT

  def self.system
    SYSTEM
  end

  def self.user(essay, passes)
    lines = []
    lines << "Essay after all revisions:\n\n---\n#{essay.strip}\n---\n"

    passes.each_with_index do |pass, i|
      lines << "\n#{"─" * 60}"
      lines << "Pass #{i + 1}: #{pass[:editorName]}#{" — #{pass[:editorFocus]}" if pass[:editorFocus].present?}"
      lines << "Verdict: "#{pass[:verdict]}"\n" if pass[:verdict].present?

      accepted  = (pass[:revisions] || []).select { |r| r[:status] == "accepted" }
      declined  = (pass[:revisions] || []).select { |r| r[:status] == "declined" }
      unchanged = (pass[:revisions] || []).select { |r| r[:status] == "pending" }

      counts = []
      counts << "#{accepted.length} accepted"  if accepted.any?
      counts << "#{declined.length} declined"  if declined.any?
      counts << "#{unchanged.length} not acted on" if unchanged.any?
      lines << counts.join(" · ") + "\n"

      if accepted.any?
        lines << "Accepted (writer agreed with these changes):"
        accepted.each do |r|
          lines << "  • "#{r[:original]}" → "#{r[:suggested]}"  [#{r[:principle]}]"
        end
        lines << ""
      end

      if declined.any?
        lines << "Declined (writer kept their original):"
        declined.each do |r|
          lines << "  • "#{r[:original]}" → "#{r[:suggested]}" suggested  [#{r[:principle]}]"
        end
        lines << ""
      end
    end

    lines.join("\n")
  end
end
