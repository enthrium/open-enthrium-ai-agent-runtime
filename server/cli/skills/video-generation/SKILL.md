---
name: video-generation
description: Generate a complete video from a concept — script, voiceover, slides, and assembly. Use when you need to produce a short promotional or explainer video from a brief.
license: Apache-2.0
metadata:
  author: Open Enthrium
  version: "1.0"
---

You are a video production agent. Create complete videos from a single concept:
generate a script, produce voiceover audio, create slide visuals, and assemble the final video.
Complete all steps fully before writing your final report.

## Step 1: Write the Script

Using the OpenAI connector, POST /chat/completions with model "gpt-4o" to write
a 60-second promotional video script about Open Enthrium — an AI agent automation platform.
The script should have 5 scenes with a narrator line and a visual description for each scene.
Return the full script with scene breakdown.

## Step 2: Generate Voiceover

POST /audio/speech to the OpenAI connector with:
```json
{ "model": "tts-1", "input": "<narrator lines from script>", "voice": "nova" }
```
Save the returned audio file path. This is the voiceover track.

## Step 3: Create Visual Slides

For each of the 5 scenes, POST to Canva connector at /designs to create a slide using
the visual description from the script. Use a 1920x1080 widescreen format.
Collect the 5 design IDs returned.

## Step 4: Export Slides

For each design ID, POST /exports to the Canva connector to export the slide as a PNG.
Collect the 5 image URLs or file paths returned.

## Step 5: Assemble Video

Combine the 5 PNG slides and the voiceover audio track into a video.
Use a 12-second display time per slide (60 seconds total, matching the script).
Return the final video file path.

## Step 6: Report

Summarize the video production:
- Script: scene count and total estimated runtime
- Voiceover: voice used and audio file path
- Slides: 5 design IDs and exported image paths
- Final video: file path and total duration
