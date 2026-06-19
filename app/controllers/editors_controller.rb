# The "editor primer" page (school view in the TSX prototype) plus the
# endpoints for editing/resetting a per-editor custom prompt override.
class EditorsController < ApplicationController
  before_action :set_editor

  def show
  end

  def update_prompt
    PromptStore.set(@editor.key, params.require(:prompt))
    render json: { ok: true, prompt: @editor.prompt }
  end

  def reset_prompt
    PromptStore.delete(@editor.key)
    render json: { ok: true, prompt: @editor.prompt }
  end

  private

  def set_editor
    @editor = Editor.find(params[:key])
    head :not_found unless @editor
  end
end
