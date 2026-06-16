# In-memory store for per-editor custom prompt overrides.
#
# This mirrors the TSX prototype's `window.storage` calls, which persisted
# custom prompts across sessions in the Artifact sandbox. Here we keep it
# simple: a process-wide Hash, reset whenever the server restarts.
#
# Future extension point: replace this with a CustomPrompt ActiveRecord
# model (editor_key:string, prompt_text:text) backed by SQLite/Postgres if
# prompts need to survive restarts or be scoped per user.
class PromptStore
  MUTEX = Mutex.new

  class << self
    def get(editor_key)
      store[editor_key]
    end

    def set(editor_key, prompt_text)
      MUTEX.synchronize { store[editor_key] = prompt_text }
    end

    def delete(editor_key)
      MUTEX.synchronize { store.delete(editor_key) }
    end

    def custom?(editor_key)
      store.key?(editor_key)
    end

    private

    def store
      @store ||= {}
    end
  end
end
