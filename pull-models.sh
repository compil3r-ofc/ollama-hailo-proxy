# Pull all of hailo-ollama compat models
for model in "qwen2.5-coder:1.5b" "deepseek_r1:1.5b" "qwen3:1.7b" "llama3.2:1b" "qwen2:1.5b"; do
  echo "Pulling $model..."
  curl -s http://localhost:8000/api/pull \
    -H 'Content-Type: application/json' \
    -d "{\"model\": \"$model\", \"stream\": true}"
  echo ""
done
