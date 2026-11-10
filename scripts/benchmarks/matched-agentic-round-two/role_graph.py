"""Explicit, bounded role ancestry for the separately labelled heavy study."""
from native_team_policy import require

HEAVY_ROLE_PARENTS = {
    "backend_coordinator": "lead",
    "backend_api": "backend_coordinator",
    "backend_data": "backend_coordinator",
    "frontend_worker": "lead",
    "qa_specialist": "lead",
    "team_judge": "lead",
}
HEAVY_ROLES = tuple(HEAVY_ROLE_PARENTS)


class RoleGraph:
    def __init__(self, roles, parents=None):
        require(len(roles) == len(set(roles)) and all(isinstance(role, str) and role and role != "lead" for role in roles), "invalid fixed roles")
        require(len(roles) == 3 if parents is None else 1 <= len(roles) <= 6, "fixed role count expanded")
        require(parents is None or isinstance(parents, dict), "explicit role graph required")
        self.parents = dict.fromkeys(roles, "lead") if parents is None else dict(parents)
        require(set(self.parents) == set(roles) and all(isinstance(parent, str) and parent in {*roles, "lead"} for parent in self.parents.values()), "role graph does not match fixed roles")
        self.depths = {"lead": 0}
        for role in roles:
            seen, current = set(), role
            while current != "lead":
                require(current not in seen, "cyclic role graph")
                seen.add(current)
                current = self.parents[current]
            require(len(seen) <= 2, "role graph depth expanded")
            self.depths[role] = len(seen)
        self.max_depth = max(self.depths.values())

    def delegates(self, role):
        return role in self.parents.values()

    def admit(self, native, root_id, slots):
        if native["id"] == root_id:
            require(native["role"] == "lead" and native["parent"] is None and native["depth"] == 0, "invalid lead")
            return
        role = native["role"]
        require(role in self.parents, "unapproved child role")
        expected_role = self.parents[role]
        expected_id = root_id if expected_role == "lead" else slots.get(expected_role)
        require(expected_id is not None and native["parent"] == expected_id and native["depth"] == self.depths[role], "wrong role parent or nested depth")
        require(native.get("parentRole") == expected_role, "native parent role changed")
        require(role not in slots or slots[role] == native["id"], "duplicate lifetime slot")
