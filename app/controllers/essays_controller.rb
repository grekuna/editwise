# Renders the single-page app shell. All phase transitions (input ->
# reading -> reviewing) happen client-side in app/javascript/application.js;
# this controller just hands the page its starting data.
class EssaysController < ApplicationController
  def index
    @editors = Editor.all
  end

  def demo
    render json: { essay: DemoEssay::TEXT }
  end
end
