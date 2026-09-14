package dev.vellum.app.dto

import kotlinx.serialization.Serializable

/**
 * Minimal mirrors of the server's client-facing wire shapes
 * (@vellum/core protocol.ts). Unknown fields are ignored so the app tolerates
 * server evolution. Only what the shell and the widget need is modeled.
 */

@Serializable
data class StateDto(
    val publication: PublicationDto? = null,
    val datasets: List<DatasetDto> = emptyList(),
    val serverTime: Long = 0
)

@Serializable
data class PublicationDto(
    val revision: Int = 0,
    val contentHash: String = "",
    val publishedAt: Long = 0,
    val content: DesignDto? = null
)

@Serializable
data class DesignDto(
    val widget: WidgetSpecDto? = null
)

@Serializable
data class WidgetSpecDto(
    val components: List<WidgetComponentDto> = emptyList(),
    val datasets: List<String> = emptyList()
)

@Serializable
data class WidgetComponentDto(
    val kind: String,
    val text: String? = null,
    val emphasis: String? = null,
    val dataset: String? = null,
    val field: String? = null,
    val label: String? = null,
    val unit: String? = null,
    val maxItems: Int? = null,
    val filter: String? = null,
    val showRemainingCount: Boolean? = null,
    val assetId: String? = null,
    val alt: String? = null,
    val action: WidgetActionDto? = null
)

@Serializable
data class WidgetActionDto(
    val kind: String,
    val dataset: String? = null,
    val itemId: String? = null,
    val type: String? = null
)

@Serializable
data class DatasetDto(
    val id: String,
    val title: String = "",
    val ownership: String = "dashboard",
    val version: Int = 0,
    val updatedAt: Long = 0,
    val value: DatasetValueDto? = null
)

@Serializable
data class DatasetValueDto(
    val kind: String,
    val items: List<ListItemDto> = emptyList(),
    val values: Map<String, Double> = emptyMap()
)

@Serializable
data class ListItemDto(
    val id: String,
    val label: String,
    val done: Boolean = false
)
