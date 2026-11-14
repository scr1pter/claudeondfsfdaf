import { Dialog as Kobalte } from "@kobalte/core/dialog"
import { children, Show, type JSX } from "solid-js"
import { useI18n } from "../context/i18n"
import { IconButton } from "./icon-button"

export interface ImagePreviewProps {
  src: string
  alt?: string
  /** Drawn over the image, in a box the image's own size (for example a marker at a point in it). */
  children?: JSX.Element
}

export function ImagePreview(props: ImagePreviewProps) {
  const i18n = useI18n()
  const overlay = children(() => props.children)
  const image = () => (
    <img src={props.src} alt={props.alt ?? i18n.t("ui.imagePreview.alt")} data-slot="image-preview-image" />
  )
  return (
    <div data-component="image-preview">
      <div data-slot="image-preview-container">
        <Kobalte.Content data-slot="image-preview-content">
          <div data-slot="image-preview-header">
            <Kobalte.CloseButton
              data-slot="image-preview-close"
              as={IconButton}
              icon="close"
              variant="ghost"
              aria-label={i18n.t("ui.common.close")}
            />
          </div>
          <div data-slot="image-preview-body">
            <Show when={overlay()} fallback={image()}>
              <div data-slot="image-preview-frame">
                {image()}
                {overlay()}
              </div>
            </Show>
          </div>
        </Kobalte.Content>
      </div>
    </div>
  )
}
